"""Run: python test_catalogue.py  (asserts only, no pytest)"""

import json
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

import main
from catalogue import db

tmp = Path(tempfile.mkdtemp())
main.CATALOGUE_DB = tmp / "catalogue.db"      # a fresh DB, seeded from catalogue.json + prices.db
main.UPLOADS = tmp / "uploads"                # ...and no local uploads
client = TestClient(main.app)

# schema — a product that does not validate fails here, loudly
body = client.get("/api/catalogue").json()
assert body["catalogue"]["units"] == "cm" and body["catalogue"]["version"] == 3
assert len(body["products"]) == body["catalogue"]["product_count"] == body["catalogue"]["total"]

by_id = {p["id"]: p for p in body["products"]}

# the published id contract: every catalogue.json product/variant id, unchanged, same order
seed = json.loads(main.CATALOGUE.read_text())["products"]
assert [p["id"] for p in body["products"]] == [p["id"] for p in seed]
for p in seed:
    got = by_id[p["id"]]
    assert got["retailer"] == "roomify"
    assert [(v["id"], v["glb"], v["model"], v["dimensions"]) for v in got["variants"]] == \
        [(v["id"], v["glb"], v.get("model"), v["dimensions"]) for v in p["variants"]], p["id"]
    assert got["category"] in db.TAXONOMY["categories"], got["category"]

# price merge — exact name hit, category fallback, structural items unpriced
assert by_id["dresser"]["price_source"] == "epics:Dresser"        # name match
assert by_id["full-bed"]["price_source"] == "epics:Bed"           # category fallback
assert by_id["closed-door"]["price"] is None                      # no price for doors
lo, hi = by_id["full-bed"]["price_min"], by_id["full-bed"]["price_max"]
assert by_id["full-bed"]["price"] == round((lo + hi) / 2)
assert lo < hi, "a name listed under several room types must span them all"
assert sum(p["price"] is not None for p in by_id.values()) == 18

# curated price wins over the merge
curated = {**by_id["full-bed"], "price": 1.0}
db.merge_price(curated, db.load_prices(main.PRICE_DB))
assert curated["price"] == 1.0 and curated["price_min"] == lo

# every asset carries its provenance
with main.catalogue_db() as con:
    assets = con.execute("select * from assets").fetchall()
assert assets and all(a["license"] and a["source"] and a["sha256"] for a in assets)

# filters
q = lambda s: client.get(f"/api/catalogue/products?{s}").json()
assert {p["category"] for p in q("category=sofa")} == {"sofa"}
assert all(p["price"] <= 5000 for p in q("max_price=5000"))
assert all(p["price"] >= 20000 for p in q("min_price=20000"))
assert all("bedroom" in p["room_types"] for p in q("room_type=bedroom")) and q("room_type=bedroom")
narrow = q("max_width_cm=50")
assert narrow and all(
    any(v["dimensions"] and v["dimensions"]["width"] <= 50 for v in p["variants"])
    for p in narrow)
fits = q("max_width_cm=100&max_depth_cm=100&max_height_cm=100")
assert fits and all(any(v["dimensions"]["width"] <= 100 and v["dimensions"]["depth"] <= 100
                        and v["dimensions"]["height"] <= 100 for v in p["variants"]) for p in fits)
assert client.get("/api/catalogue/products?category=spaceship").status_code == 422
assert client.get("/api/catalogue/products?room_type=garage").status_code == 422

# pagination: pages tile the full list, total is the unpaged count
page = client.get("/api/catalogue?limit=5&offset=5").json()
assert [p["id"] for p in page["products"]] == list(by_id)[5:10]
assert page["catalogue"]["total"] == len(by_id) and page["catalogue"]["product_count"] == 5
sofas = client.get("/api/catalogue?category=sofa&limit=2").json()
assert sofas["catalogue"]["total"] == 4 and len(sofas["products"]) == 2

# published ids resolve; unknown ones 404 rather than returning empty
assert client.get("/api/catalogue/products/full-bed").json()["name"] == "Full Bed"
assert client.get("/api/catalogue/products/no-such-thing").status_code == 404

print(f"ok — {len(by_id)} products, "
      f"{sum(p['price'] is not None for p in by_id.values())} priced, {len(assets)} assets")
