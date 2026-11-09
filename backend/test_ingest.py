"""Ingestion (C2): real GLBs land as needs_review with the right issues, broken ones are rejected
with a readable reason, and none of them crash it.

Run: python test_ingest.py  (asserts only, no pytest; needs node + 3d_room/node_modules. The
white sofa and uploads-debug/ are git-ignored: their checks are skipped when missing)
"""

import json
import struct
import tempfile
from pathlib import Path

import glb
import main
from catalogue import ingest

tmp = Path(tempfile.mkdtemp())
main.CATALOGUE_DB = tmp / "catalogue.db"
main.UPLOADS = tmp / "uploads"
ingest.ASSETS = tmp / "assets"
APP = main.ROOT / "3d_room"
SOFA_2 = APP / "example/models/glb/sofa-2-1773380818620.glb"   # tracked: always here
WHITE_SOFA = APP / "example/models/uploads/white-sofa.glb"
DEBUG = sorted((APP / "uploads-debug").glob("*.glb"))
CC0 = {"license": "CC0", "source": "test", "source_url": None, "attribution": None, "non_commercial": 0}


def box(size, *, indices=(0, 1, 2, 3, 4, 5, 6, 7, 0), uri=None, scene_nodes=(0,), variants=False) -> bytes:
    """An 8-vertex box GLB; the keywords break it in one way each."""
    pos = [(x, y, z) for x in (0, size[0]) for y in (0, size[1]) for z in (0, size[2])]
    bin = struct.pack("<24f", *sum(pos, ())) + struct.pack(f"<{len(indices)}H", *indices)
    prim = {"attributes": {"POSITION": 0}, "indices": 1, "material": 0}
    gltf = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": list(scene_nodes)}],
        "nodes": [{"mesh": 0}], "meshes": [{"primitives": [prim]}],
        "materials": [{"name": "upholstery"}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3",
                       "min": [0, 0, 0], "max": list(size)},
                      {"bufferView": 1, "componentType": 5123, "count": len(indices), "type": "SCALAR"}],
        "bufferViews": [{"buffer": 0, "byteLength": 96, "target": 34962},
                        {"buffer": 0, "byteOffset": 96, "byteLength": 2 * len(indices), "target": 34963}],
        "buffers": [{"byteLength": len(bin) + -len(bin) % 4} | ({"uri": uri} if uri else {})],
    }
    if variants:
        gltf["materials"].append({"name": "red", "pbrMetallicRoughness": {"baseColorFactor": [1, 0, 0, 1]}})
        gltf["extensionsUsed"] = ["KHR_materials_variants"]
        gltf["extensions"] = {"KHR_materials_variants": {"variants": [{"name": "Grey"}, {"name": "Rust Red"}]}}
        prim["extensions"] = {"KHR_materials_variants": {"mappings": [
            {"material": 0, "variants": [0]}, {"material": 1, "variants": [1]}]}}
    return glb.pack(gltf, None if uri else bin)


codes = lambda r: sorted(i["code"] for i in r["issues"])
with main.catalogue_db() as con:
    run = lambda data, sku, **kw: ingest.ingest(con, data, retailer="acme", sku=sku, name=sku,
                                                provenance=kw.pop("provenance", CC0), **kw)

    # a clean, fully declared model: no issues at all, stored under its hash, not in the app yet
    data = SOFA_2.read_bytes()
    r = run(data, "Sofa 2", category="sofa", facing=0, declared={"width": 246.8, "height": 125.8, "depth": 98.4})
    assert r == {"id": "acme-sofa-2", "status": "needs_review", "issues": []}, r
    assert len(list(ingest.ASSETS.iterdir())) == 1 and next(ingest.ASSETS.iterdir()).read_bytes() == data
    assert "acme-sofa-2" not in {p["id"] for p in main.db.query(con)[1]}, "only published reaches the app"
    row = con.execute("select * from geometry_variants where product_id = 'acme-sofa-2'").fetchone()
    assert (row["width"], row["height"], row["depth"], row["unit_scale"]) == (246.8, 125.8, 98.4, None)

    # the same file again, as another sku: one stored file, two products
    assert run(data, "sofa-2-copy", category="sofa", facing=0)["status"] == "needs_review"
    assert len(list(ingest.ASSETS.iterdir())) == 1, "deduplicated by content"

    # an existing sku is not silently overwritten (updating is C6)
    try:
        run(data, "Sofa 2")
        raise AssertionError("re-ingest overwrote a product")
    except ValueError as e:
        assert "already in the catalogue" in str(e)

    # Z-up in millimetres: unit and axis found from the declared size, stood up by a root node
    r = run(box([2000, 900, 800]), "zup", category="sofa", facing=0,
            declared={"width": 200, "height": 80, "depth": 90})
    assert codes(r) == ["z_up"], r
    v = con.execute("select v.*, a.path from geometry_variants v join assets a on a.id = v.glb_asset "
                    "where product_id = 'acme-zup'").fetchone()
    assert (v["width"], v["height"], v["depth"], v["unit_scale"]) == (200, 80, 90, 0.1)
    lo, hi = glb.Glb((ingest.ASSETS / Path(v["path"]).name).read_bytes()).bounds()
    assert [round(b - a) for a, b in zip(lo, hi)] == [2000, 800, 900], "stored file is Y-up now"

    # declared size that no unit explains, no category, front unknown, unit guessed
    r = run(box([1, 1, 1]), "cube", declared={"width": 300, "height": 20, "depth": 45})
    assert codes(r) == ["facing_unknown", "no_category", "unit_mismatch"], r
    assert "300×20×45 cm" in r["issues"][0]["detail"]
    assert codes(run(box([1, 1, 1]), "cube-2", category="lamp-ish", facing=0)) == ["no_category", "unit_guessed"]

    # KHR_materials_variants: the slot and its colourways
    run(box([100, 80, 90], variants=True), "chair", category="chair", facing=0,
        provenance=CC0 | {"license": "CC BY-NC 4.0", "non_commercial": 1})
    opts = con.execute("select slot_id, id, label, factors from material_options "
                       "where product_id = 'acme-chair' order by position").fetchall()
    assert [tuple(o) for o in opts] == [("upholstery", "grey", "Grey", "{}"),
                                        ("upholstery", "rust-red", "Rust Red", '{"baseColorFactor": [1, 0, 0, 1]}')]
    assert con.execute("select a.non_commercial from geometry_variants v join assets a on a.id = v.glb_asset "
                       "where product_id = 'acme-chair'").fetchone()[0] == 1

    # broken files: rejected, with a reason the sender can act on, recorded so they can see it
    good = box([100, 80, 90])
    broken = {
        "text": (b"just some bytes, not a model", "no glTF header"),
        "truncated": (good[:-8], "header says"),
        "external": (box([100, 80, 90], uri="sofa.bin"), "external file"),
        "out-of-range": (box([100, 80, 90], indices=(0, 1, 99)), "glTF validator"),
        "empty-scene": (box([100, 80, 90], scene_nodes=()), ""),
        "bad-json": (b"glTF" + struct.pack("<II", 2, 28) + struct.pack("<II", 8, glb.JSON_CHUNK) + b"{nope!!}", "unreadable"),
    }
    for sku, (data, reason) in broken.items():
        r = run(data, sku, category="sofa", facing=0)
        assert r["status"] == "rejected" and reason in r["issues"][0]["detail"], (sku, r)
    assert con.execute("select count(*) from products where status = 'rejected'").fetchone()[0] == len(broken)

    # a rejected sku sent again, fixed, replaces the rejection
    assert run(good, "truncated", category="sofa", facing=0)["status"] == "needs_review"

    # the real corpus: the white sofa (metres, 281k triangles, 3k textures) and uploads-debug/
    if WHITE_SOFA.exists():
        r = run(WHITE_SOFA.read_bytes(), "white-sofa", category="sofa",
                declared={"width": 100, "height": 26, "depth": 46})
        assert codes(r) == ["facing_unknown", "over_budget"], r
        assert "281,513 triangles" in r["issues"][1]["detail"] and "3072×3072" in r["issues"][1]["detail"]
    for f in DEBUG:
        r = run(f.read_bytes(), f"debug-{f.stem}")
        assert r["status"] == "needs_review" and "unit_guessed" in codes(r), (f.name, r)
        print(f"  {f.name}: {codes(r)}")

print("OK — ingestion: clean, Z-up/mm, unit mismatch, variants, 6 broken files rejected"
      + ("" if WHITE_SOFA.exists() and DEBUG else " (git-ignored corpus missing: its checks skipped)"))
