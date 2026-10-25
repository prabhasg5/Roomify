"""Model upload: stored byte-identical, measured like gltf-transform, listed in the catalogue.

Run: python test_uploads.py  (asserts only, no pytest; needs node + 3d_room/node_modules
for the getBounds reference, and the git-ignored problem GLB, skipped if missing)
"""

import json
import subprocess
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

import glb
import main

main.UPLOADS = Path(tempfile.mkdtemp())        # don't write into example/models/uploads
client = TestClient(main.app)
APP = main.ROOT / "3d_room"
PROBLEM = APP / "example/models/glb/white-sofa-1790761067934.glb"
CATALOGUE_GLB = APP / "example/models/glb/sofa-2-1773380818620.glb"   # Z-up rotated root node


def gltf_transform_bounds(path: Path) -> tuple[list, list]:
    js = ("const {NodeIO}=require('@gltf-transform/core');const {ALL_EXTENSIONS}=require('@gltf-transform/extensions');"
          "const {getBounds}=require('@gltf-transform/functions');new NodeIO().registerExtensions(ALL_EXTENSIONS)"
          ".read(process.argv[1]).then(d=>console.log(JSON.stringify(getBounds(d.getRoot().listScenes()[0]))))")
    out = json.loads(subprocess.run(["node", "-e", js, str(path)], cwd=APP, check=True,
                                    capture_output=True, text=True).stdout)
    return out["min"], out["max"]


# the server's bbox is gltf-transform's, to float precision
for path in [p for p in (PROBLEM, CATALOGUE_GLB) if p.exists()]:
    want_lo, want_hi = gltf_transform_bounds(path)
    lo, hi = glb.Glb(path.read_bytes()).bounds()
    assert all(abs(a - b) < 1e-9 for a, b in zip(lo + hi, want_lo + want_hi)), (path.name, lo, hi, want_lo, want_hi)

# a catalogue GLB in cm uploads at ×1, sized like its catalogue entry
data = CATALOGUE_GLB.read_bytes()
r = client.post("/api/uploads", data={"name": "Sofa 2", "type": "1"},
                files={"model": ("sofa-2.glb", data, "model/gltf-binary")})
assert r.status_code == 200, r.text
product = r.json()
assert product["id"] == "sofa-2-2", "slug taken by the built-in sofa-2: made unique, not reused"
v = product["variants"][0]
assert (main.UPLOADS / "sofa-2-2.glb").read_bytes() == data, "stored byte-identical to the upload"
assert v["glb"] == "models/uploads/sofa-2-2.glb" and v["id"] == "default" and v["source"] == "upload"
assert v["dimensions"] == {"width": 246.8, "height": 125.8, "depth": 98.4}, v["dimensions"]
assert v.get("unit_scale") is None
assert v["stats"] == {"triangles": 13664, "bytes": len(data),
                      "textures": [{"width": 512, "height": 512, "mime_type": "image/png"}]}
assert v["thumbnail"] is None

# it is in the catalogue now, under the same id
ids = {p["id"] for p in client.get("/api/catalogue").json()["products"]}
assert "sofa-2-2" in ids and "sofa-2" in ids

# the problem GLB: metres, auto ×100, the thumbnail stored as posted
if PROBLEM.exists():
    data = PROBLEM.read_bytes()
    png = b"\x89PNG\r\n\x1a\n" + bytes(32)
    r = client.post("/api/uploads", data={"name": "White sofa", "type": "1", "scale": "auto"},
                    files={"model": ("white-sofa.glb", data), "thumbnail": ("t.png", png, "image/png")})
    assert r.status_code == 200, r.text
    v = r.json()["variants"][0]
    assert (main.UPLOADS / "white-sofa.glb").read_bytes() == data, "stored byte-identical to the upload"
    assert (main.UPLOADS / "white-sofa.png").read_bytes() == png
    assert v["unit_scale"] == 100 and v["dimensions"] == {"width": 100.2, "height": 26.3, "depth": 46.0}, v
    assert v["stats"]["triangles"] == 281513 and v["stats"]["bytes"] == 10585432
    assert v["stats"]["textures"] == [{"width": 3072, "height": 3072, "mime_type": "image/png"}] * 2

# refusals
bad = lambda **kw: client.post("/api/uploads", data={"name": "x", **kw.pop("form", {})},
                               files={"model": ("x.glb", kw.pop("model", data))} | kw)
assert bad(model=b"not a glb at all, just bytes").status_code == 422
assert bad(model=data[:-4]).status_code == 422, "truncated: header length mismatch"
assert bad(form={"type": "5"}).status_code == 422
assert bad(form={"scale": "3"}).status_code == 422
assert bad(thumbnail=("t.txt", b"hello")).status_code == 422
main.MAX_MODEL, cap = 1000, main.MAX_MODEL
assert bad().status_code == 413
main.MAX_MODEL = cap
before = json.loads((main.UPLOADS / "uploads.json").read_text())
assert len(before) == (2 if PROBLEM.exists() else 1), "refused uploads leave no entry"

# delete: files and entry go, built-ins can't be deleted, the id is never handed out again
assert client.delete("/api/uploads/sofa-2").status_code == 404, "built-in"
r = client.delete("/api/uploads/sofa-2-2")
assert r.status_code == 200, r.text
assert not (main.UPLOADS / "sofa-2-2.glb").exists()
assert "sofa-2-2" not in {p["id"] for p in client.get("/api/catalogue").json()["products"]}
assert client.delete("/api/uploads/sofa-2-2").status_code == 404, "already deleted"
r = client.post("/api/uploads", data={"name": "Sofa 2"}, files={"model": ("sofa-2.glb", CATALOGUE_GLB.read_bytes())})
assert r.json()["id"] == "sofa-2-3", "a deleted upload's id is not reused"

print("OK — uploads stored byte-identical, bbox = gltf-transform getBounds"
      + ("" if PROBLEM.exists() else " (problem GLB missing: its checks skipped)"))
