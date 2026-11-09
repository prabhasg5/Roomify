"""Ingestion: the one way a GLB enters the catalogue (CATALOGUE_GUIDE.md §9, step C2).

Every model goes through the same stages, whoever sends it: a retailer, a C3 importer (a "fake
retailer") or the app's own upload (main.py runs stages 1–4 via inspect(), then picks its own id):

  1. validate   glb.py's structural checks, then the Khronos validator (3d_room/tools/
                validate-glb.mjs, so the server needs node). Any validator error rejects the file.
  2. normalize  cm per GLB unit and the up axis, from the measured box against the declared
                dimensions. A Z-up model gets a rotated root node; no vertex changes.
  3. measure    dimensions, triangles, textures
  4. materials  each named material a primitive draws with is a slot, its KHR_materials_variants
                are the slot's options
  5. store      example/models/assets/<sha256>.glb: immutable, deduplicated
  6. write      the product + one geometry variant, status needs_review, with issues[]

No optimize stage: a heavy model is flagged `over_budget`, never altered. ponytail: add
gltf-transform optimize (lossless always, lossy over budget, keep the original) when users complain.

A file never crashes ingestion: it lands with issues, or it is rejected with a readable reason.

    python -m catalogue.ingest sofa.glb --retailer acme --license CC0 --dims 200 85 90 --category sofa
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from struct import error as struct_error

import glb
from catalogue import db

APP = Path(__file__).resolve().parents[2] / "3d_room"
# Under example/ so the app fetches them like the catalogue's own GLBs (asset urls are relative to it).
ASSETS = APP / "example" / "models" / "assets"
PLACEMENT = {1: "floor", 2: "wall", 3: "in_wall", 7: "in_wall_floor", 8: "on_floor", 9: "wall_floor"}
UNITS = {0.1: "mm", 1.0: "cm", 2.54: "inches", 10.0: "dm", 30.48: "feet", 100.0: "m"}   # cm per GLB unit
FIT = 0.1                    # declared vs measured dimensions, relative
# ponytail: guessed budgets, C7 measures the real ones
TRIANGLE_BUDGET = 100_000
TEXTURE_BUDGET = 2048
Y_UP = [-0.7071067811865476, 0, 0, 0.7071067811865476]   # -90° about X: +Z up becomes +Y up


class Rejected(Exception):
    """The file can't enter the catalogue; the message is for the sender."""


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def r1(n: float) -> float:
    """0.1 cm, as build-catalogue.js rounds the catalogue's dimensions."""
    return round(n * 10) / 10


# ── stages 1–4: no DB, no files ──────────────────────────────────────────────
def inspect(data: bytes, *, declared: dict | None = None, scale: float | None = None,
            category: str | None = None, facing: float | None = None) -> dict:
    """A partial product in the API shape, plus "data" (the bytes to store) and "issues".
    declared = {width, height, depth} in cm; scale = cm per unit, forced (no guess, no Z-up check)."""
    issues = []
    issue = lambda code, detail: issues.append({"code": code, "detail": detail})
    try:
        g = glb.Glb(data)
        warnings = validate(data)
        lo, hi = g.bounds()
        unit, z_up = normalize([b - a for a, b in zip(lo, hi)], declared, scale, issue)
        if z_up:
            gltf = json.loads(json.dumps(g.json))
            scene = gltf["scenes"][gltf.get("scene", 0)]
            gltf.setdefault("nodes", []).append({"name": "roomify-y-up", "rotation": Y_UP, "children": scene["nodes"]})
            scene["nodes"] = [len(gltf["nodes"]) - 1]
            data = glb.pack(gltf, g.bin)
            g = glb.Glb(data)
            lo, hi = g.bounds()
        size = [(b - a) * unit for a, b in zip(lo, hi)]
        stats = {"triangles": g.triangles(), "textures": g.textures(), "bytes": g.size}
        slots = material_slots(g.json)
    except glb.GlbError as e:
        raise Rejected(str(e)) from None
    except (KeyError, IndexError, TypeError, ValueError, struct_error) as e:
        raise Rejected(f"GLB is malformed ({e.__class__.__name__}: {e})") from None

    if warnings:
        issue("validator_warnings", "; ".join(m["message"] for m in warnings[:3])
              + (f" (+{len(warnings) - 3} more)" if len(warnings) > 3 else ""))
    if category not in db.TAXONOMY["categories"] or category == "uncategorised":
        issue("no_category", f"category {category!r} is not in taxonomy.json" if category else "no category")
        category = "uncategorised"
    if facing is None:
        issue("facing_unknown", "which side is the front was not declared (the spec: front = +Z)")
    big = [f"{t['width']}×{t['height']}" for t in stats["textures"] if max(t["width"] or 0, t["height"] or 0) > TEXTURE_BUDGET]
    if stats["triangles"] > TRIANGLE_BUDGET or big:
        issue("over_budget", f"{stats['triangles']:,} triangles (budget {TRIANGLE_BUDGET:,})"
              + (f", textures {', '.join(big)} (budget {TEXTURE_BUDGET})" if big else ""))
    return {
        "data": data, "category": category, "facing_offset_deg": facing or 0, "issues": issues,
        "material_slots": slots,
        "variants": [{"id": "default", "label": "Default", "unit_scale": unit if unit != 1 else None,
                      "dimensions": dict(zip(("width", "height", "depth"), map(r1, size))), "stats": stats}],
    }


def validate(data: bytes) -> list[dict]:
    """Stage 1, the Khronos validator: errors reject, warnings come back for issues[]."""
    out = subprocess.run(["node", "tools/validate-glb.mjs"], input=data, cwd=APP,
                         capture_output=True, check=True, timeout=300)
    messages = json.loads(out.stdout)["messages"]
    errors = [m for m in messages if m["severity"] == 0]
    if errors:
        raise Rejected("glTF validator: " + "; ".join(f"{m['message']} ({m.get('pointer', '')})" for m in errors[:3])
                       + (f" (+{len(errors) - 3} more errors)" if len(errors) > 3 else ""))
    return [m for m in messages if m["severity"] == 1]


def normalize(size: list[float], declared: dict | None, scale: float | None, issue) -> tuple[float, bool]:
    """Stage 2: (cm per GLB unit, modelled Z-up). The unit and axis that best match the declared
    dimensions win; width and depth may be swapped (that is facing, a separate question)."""
    if scale:
        return scale, False
    if not declared:
        unit = glb.auto_scale(size)
        issue("unit_guessed", f"no declared dimensions: guessed {UNITS[unit]} from the model's size")
        return unit, False
    W, H, D = declared["width"], declared["height"], declared["depth"]
    best = (float("inf"), 1.0, False)
    for z_up in (False, True):
        x, y, z = (size[0], size[2], size[1]) if z_up else size
        for u in UNITS:
            off = max(abs(y * u - H) / H, min(max(abs(x * u - W) / W, abs(z * u - D) / D),
                                              max(abs(z * u - W) / W, abs(x * u - D) / D)))
            if off < best[0]:
                best = (off, u, z_up)
    off, unit, z_up = best
    if off <= FIT:
        if z_up:
            issue("z_up", "modelled Z-up: a root rotation stands it upright")
        return unit, z_up
    unit = glb.auto_scale(size)
    issue("unit_mismatch", f"declared {W:g}×{H:g}×{D:g} cm but the model measures "
          f"{'×'.join(f'{s:.4g}' for s in size)} units: no unit or up axis fits within {FIT:.0%}; "
          f"guessed {UNITS[unit]}")
    return unit, False


def material_slots(gltf: dict) -> list[dict]:
    """Stage 4. ponytail: unnamed materials are not slots (the retailer spec says name them)."""
    mats = gltf.get("materials", [])
    variants = gltf.get("extensions", {}).get("KHR_materials_variants", {}).get("variants", [])
    slots: dict[str, dict[int, int]] = {}   # slot name → {variant index: material index}
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            name = mats[prim["material"]].get("name") if "material" in prim else None
            if not name:
                continue
            options = slots.setdefault(name, {})
            for m in prim.get("extensions", {}).get("KHR_materials_variants", {}).get("mappings", []):
                for v in m["variants"]:
                    options.setdefault(v, m["material"])
    return [{"id": name, "label": name, "options": [{
        "id": slug(variants[v].get("name", "")) or f"variant-{v}",
        "label": variants[v].get("name") or f"Variant {v + 1}",
        "factors": {k: f for k, f in mats[m].get("pbrMetallicRoughness", {}).items() if k.endswith("Factor")},
        "attributes": {"variant": v, "material": m},
    } for v, m in sorted(options.items())]} for name, options in slots.items()]


# ── stages 5–6 ───────────────────────────────────────────────────────────────
def store(data: bytes) -> str:
    """The asset url. The same bytes always land on the same file, so a re-send costs nothing."""
    sha = hashlib.sha256(data).hexdigest()
    path = ASSETS / f"{sha}.glb"
    if not path.exists():
        ASSETS.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_bytes(data)
        tmp.replace(path)   # never a half-written file under the final name
    return f"models/assets/{path.name}"


def ingest(con, data: bytes, *, retailer: str, sku: str, name: str, provenance: dict,
           category: str | None = None, item_type: int = 1, declared: dict | None = None,
           facing: float | None = None) -> dict:
    """The whole pipeline for one GLB: {"id", "status", "issues"}. The id is `<retailer>-<sku>`,
    immutable. A rejected file is recorded too (reason in issues) so the sender sees why;
    sending the sku again replaces it. provenance = license, source, source_url, attribution,
    non_commercial (db.BUILT_IN's keys)."""
    pid = slug(f"{retailer}-{sku}")
    try:
        p = inspect(data, declared=declared, category=category, facing=facing)
        url = store(p.pop("data"))   # outside the transaction: inspect is slow, store is idempotent
    except Rejected as e:
        p, reason = None, str(e)
    with db.tx(con):
        con.execute("insert or ignore into retailers values (?, ?, ?)", (retailer, retailer, db.now()))
        row = con.execute("select status from products where id = ?", (pid,)).fetchone()
        if row and row["status"] != "rejected":
            # ponytail: updating a product in place is C6's (retailer onboarding)
            raise ValueError(f"{pid} is already in the catalogue ({row['status']})")
        con.execute("delete from products where id = ?", (pid,))
        if p is None:
            issues = [{"code": "rejected", "detail": reason}]
            con.execute("insert into products (id, retailer_id, sku, status, issues, name, category, "
                        "item_type, placement, created, updated) values (?, ?, ?, 'rejected', ?, ?, "
                        "'uncategorised', ?, ?, ?, ?)", (pid, retailer, sku, json.dumps(issues), name,
                                                          item_type, PLACEMENT[item_type], db.now(), db.now()))
            return {"id": pid, "status": "rejected", "issues": issues}
        p.update(id=pid, sku=sku, name=name, item_type=item_type, placement=PLACEMENT[item_type])
        p["variants"][0].update(glb=url, source=retailer)
        db.insert_product(con, p, retailer, provenance, lambda u: ASSETS / Path(u).name, "needs_review")
    return {"id": pid, "status": "needs_review", "issues": p["issues"]}


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m catalogue.ingest", description=__doc__.split("\n\n")[0])
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--retailer", required=True)
    ap.add_argument("--sku", help="default: the file name (one file only)")
    ap.add_argument("--name", help="default: the file name (one file only)")
    ap.add_argument("--category", help="a taxonomy.json category")
    ap.add_argument("--type", type=int, default=1, choices=sorted(PLACEMENT), help="engine item type")
    ap.add_argument("--dims", nargs=3, type=float, metavar=("W", "H", "D"), help="declared size, cm (one file only)")
    ap.add_argument("--facing", type=float, help="degrees the model turns so its front faces +Z")
    ap.add_argument("--license", required=True)
    ap.add_argument("--source", help="default: the retailer")
    ap.add_argument("--source-url")
    ap.add_argument("--attribution")
    ap.add_argument("--non-commercial", action="store_true")
    a = ap.parse_args(argv)
    if len(a.files) > 1 and (a.sku or a.name or a.dims):
        ap.error("--sku, --name and --dims describe one file")
    if a.dims and min(a.dims) <= 0:
        ap.error("--dims must be positive")
    provenance = {"license": a.license, "source": a.source or a.retailer, "source_url": a.source_url,
                  "attribution": a.attribution, "non_commercial": int(a.non_commercial)}
    import main as app   # the app's DB and seed; run from backend/
    with app.catalogue_db() as con:
        for f in a.files:
            print(json.dumps(ingest(
                con, f.read_bytes(), retailer=a.retailer, sku=a.sku or f.stem, name=a.name or f.stem,
                provenance=provenance, category=a.category, item_type=a.type, facing=a.facing,
                declared=a.dims and dict(zip(("width", "height", "depth"), a.dims)))))


if __name__ == "__main__":
    main()
