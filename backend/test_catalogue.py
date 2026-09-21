"""Run: python test_catalogue.py  (asserts only, no pytest)"""

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)

# schema — a catalogue.json that does not validate fails here, loudly
body = client.get("/api/catalogue").json()
assert body["catalogue"]["units"] == "cm"
assert len(body["products"]) == body["catalogue"]["product_count"]

by_id = {p["id"]: p for p in body["products"]}

# price merge — exact name hit, category fallback, structural items unpriced
assert by_id["dresser"]["price_source"] == "epics:Dresser"        # name match
assert by_id["full-bed"]["price_source"] == "epics:Bed"           # category fallback
assert by_id["closed-door"]["price"] is None                      # no price for doors
lo, hi = by_id["full-bed"]["price_min"], by_id["full-bed"]["price_max"]
assert by_id["full-bed"]["price"] == round((lo + hi) / 2)
assert lo < hi, "a name listed under several room types must span them all"

# curated price wins over the merge
curated = main.Product(**{**by_id["full-bed"], "price": 1.0})
main.merge_price(curated, main.load_prices())
assert curated.price == 1.0 and curated.price_min == lo

# filters
assert {p["category"] for p in client.get(
    "/api/catalogue/products?category=sofa").json()} == {"sofa"}
assert all(p["price"] <= 5000 for p in client.get(
    "/api/catalogue/products?max_price=5000").json())
narrow = client.get("/api/catalogue/products?max_width_cm=50").json()
assert narrow and all(
    any(v["dimensions"] and v["dimensions"]["width"] <= 50 for v in p["variants"])
    for p in narrow)

# published ids resolve; unknown ones 404 rather than returning empty
assert client.get("/api/catalogue/products/full-bed").json()["name"] == "Full Bed"
assert client.get("/api/catalogue/products/no-such-thing").status_code == 404

print(f"ok — {len(by_id)} products, "
      f"{sum(p['price'] is not None for p in by_id.values())} priced")
