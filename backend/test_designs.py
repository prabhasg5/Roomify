"""Designs + the AR serving the phone reads them through.

Run: python test_designs.py  (asserts only, no pytest)
"""

import json
import os
import re
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

import main

main.DESIGNS = Path(tempfile.mkdtemp())        # don't write into ar_view/models
client = TestClient(main.app)

design = {
    "floorplan": {"corners": {"c1": {"x": 0, "y": 0}}, "walls": []},
    "items": [{
        "item_name": "Full Bed", "item_type": 1,
        "model_url": "models/js/ik_nordli_full.js",
        "product_id": "full-bed", "variant_id": "default",
        "xpos": 10.5, "ypos": 0, "zpos": -20, "rotation": 1.57,
        "fixed": False,                         # extra engine fields survive
    }],
}

r = client.post("/api/designs", json=design)
assert r.status_code == 200, r.text
name = r.json()["filename"]

# ar-server.js's /current-design only picks up files matching this
assert re.fullmatch(r"design-\d+\.json", name), name

# persisted verbatim — nothing dropped or re-serialised on the way through
saved = json.loads((main.DESIGNS / name).read_text())
assert saved == design
assert saved["items"][0]["product_id"] == "full-bed", "the published id must survive"

# a design without items or floorplan is not a design
assert client.post("/api/designs", json={"items": []}).status_code == 422
assert client.post("/api/designs", json={"floorplan": {}}).status_code == 422
# an item missing its position would place furniture nowhere
assert client.post("/api/designs", json={
    "floorplan": {}, "items": [{"item_name": "x", "item_type": 1,
                                "model_url": "m.js", "rotation": 0}]}).status_code == 422

# old designs predate the id contract and must still save
old = json.loads(json.dumps(design))
del old["items"][0]["product_id"], old["items"][0]["variant_id"]
assert client.post("/api/designs", json=old).status_code == 200

# ── the read path the phone uses (same-origin off this same server) ─────────

# /current-design picks the newest by FILENAME, not mtime — the name is the
# contract, and a re-saved older file must not win. (Both are dated past the
# designs posted above, which carry a real ms timestamp.)
newer, older = main.DESIGNS / "design-9000000000001.json", main.DESIGNS / "design-9000000000000.json"
newer.write_text('{"floorplan":{},"items":[],"tag":"new"}')
older.write_text('{"floorplan":{},"items":[],"tag":"old"}')
os.utime(newer, (1, 1))                   # ...and the newest name is the oldest file
assert client.get("/current-design").json()["tag"] == "new"

assert client.get(f"/design/{older.name}").json()["tag"] == "old"
assert client.get("/design/nope.json").status_code == 404
# the filename is joined onto a directory: only plain names get through
for attack in ("../main.py", "..%2fmain.py", "..", ".env"):
    assert client.get(f"/design/{attack}").status_code == 404, attack

# models: list is newest-first, cleanup keeps the 10 newest
for i in range(12):
    glb = main.DESIGNS / f"room-design-{1000 + i}.glb"
    glb.write_bytes(b"glTF fake")
    os.utime(glb, (i, i))
listed = client.get("/list-models").json()["models"]
assert [m["name"] for m in listed][:2] == ["room-design-1011.glb", "room-design-1010.glb"]
assert client.post("/cleanup").json()["deleted"] == 2
assert len(client.get("/list-models").json()["models"]) == 10

up = client.post("/upload-model", files={"model": ("room.glb", b"glTF fake", "model/gltf-binary")})
assert up.status_code == 200 and up.json()["filename"].endswith(".glb"), up.text
assert (main.DESIGNS / up.json()["filename"]).read_bytes() == b"glTF fake"
assert client.post("/upload-model",
                   files={"model": ("evil.txt", b"x", "text/plain")}).status_code == 400

# the QR code's payload
info = client.get("/api/network-info").json()
assert info["arUrl"] == f"https://{info['ip']}:8002/ar-mobile.html", info

# static: the pages and the two asset folders ar-mobile.html resolves models against
assert client.get("/ar-mobile.html").status_code == 200
assert client.get("/three/ar-exporter.js").status_code == 200
a_glb = next(main.EXAMPLE.glob("models/glb/*.glb"), None)
assert a_glb is None or client.get(f"/glb/{a_glb.name}").status_code == 200
# ar_view/ holds the TLS keypair this server is started with
assert client.get("/key.pem").status_code == 404
assert client.get("/cert.pem").status_code == 404

print(f"ok — saved {name}; design read path, models and AR static serving all answer")
