"""Run: python test_designs.py  (asserts only, no pytest)"""

import json
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

print(f"ok — saved {name}, validation rejects malformed designs")
