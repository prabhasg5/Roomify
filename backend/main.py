"""Roomify backend — the catalogue, and the design write path.

Serves 3d_room/example/catalogue.json (built by tools/build-catalogue.js) with
prices merged in from 2d_image_generation/epics.db, and accepts saved designs.
The Pydantic models below ARE the schema: a catalogue or a design that does not
validate fails here rather than in the agent.

Product/variant ids are a PUBLISHED CONTRACT (saved designs record them) — this
service passes them through untouched and never derives its own.

    uvicorn main:app --port 8080 --reload     # from this directory
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, ValidationError

ROOT = Path(__file__).resolve().parent.parent
CATALOGUE = ROOT / "3d_room" / "example" / "catalogue.json"
PRICE_DB = ROOT / "2d_image_generation" / "epics.db"
# Shared with ar-server.js, which serves and lists this directory. Until slice 5
# moves AR serving here, Python writes designs and Node reads them off disk.
DESIGNS = ROOT / "3d_room" / "ar_view" / "models"


# ── schema (catalogue.json v1) ───────────────────────────────────────────────
class Dimensions(BaseModel):
    width: float
    height: float
    depth: float


class Variant(BaseModel):
    id: str
    label: str
    model: str
    glb: str | None = None
    thumbnail: str | None = None
    dimensions: Dimensions | None = None
    price_delta: float = 0
    source: str


class Product(BaseModel):
    id: str
    name: str
    category: str
    style: str | None = None
    price: float | None = None          # curated, else filled from the price db
    placement: str
    item_type: int
    variants: list[Variant]
    # merged in here, not present in catalogue.json
    price_min: float | None = None
    price_max: float | None = None
    price_source: str | None = None


class Meta(BaseModel):
    version: int
    generated: str
    generator: str
    units: str
    note: str | None = None
    product_count: int
    variant_count: int


class Catalogue(BaseModel):
    catalogue: Meta
    products: list[Product]


# ── price merge ──────────────────────────────────────────────────────────────
# epics.db lists priced items by shop name, the catalogue by mesh name, so an
# exact name match only covers a third of it. Category is the fallback, and it
# is a hand-written map because the two vocabularies are genuinely different.
# Doors and windows are structural — deliberately unpriced.
CATEGORY_PRICE_NAME = {
    "bed": "Bed",
    "chair": "Accent Chair",
    "coffee_table": "Coffee Table",
    "dining_table": "Dining Table",
    "lighting": "Lamp",
    "media_unit": "TV Stand",
    "nightstand": "Nightstand",
    "rug": "Rug",
    "shelving": "Bookshelf",
    "side_table": "Side Table",
    "sofa": "Sofa",
    "storage": "Wardrobe",
    "wall_art": "Wall Art",
}


def load_prices() -> dict[str, tuple[float, float]]:
    """{lowercased item name: (min, max)} — the same item is listed once per
    room type at different prices, so span every row for that name."""
    if not PRICE_DB.exists():
        return {}
    with sqlite3.connect(f"file:{PRICE_DB}?mode=ro", uri=True) as db:
        rows = db.execute(
            "select lower(name), min(price_min), max(price_max) "
            "from items group by lower(name)"
        ).fetchall()
    return {name: (lo, hi) for name, lo, hi in rows}


def merge_price(product: Product, prices: dict[str, tuple[float, float]]) -> None:
    """Fill price_min/max/price. Curated `price` in catalogue.json always wins —
    derived flows up, curated is never overwritten."""
    key = product.name.lower()
    if key in prices:
        source = product.name
    else:
        source = CATEGORY_PRICE_NAME.get(product.category)
        key = source.lower() if source else None
    if key not in prices:
        return
    lo, hi = prices[key]
    product.price_min, product.price_max = lo, hi
    product.price_source = f"epics:{source}"
    if product.price is None:
        product.price = round((lo + hi) / 2)


# ── loading (mtime-cached: build-catalogue.js reruns often in dev) ───────────
_cache: tuple[float, Catalogue] | None = None


def get_catalogue() -> Catalogue:
    global _cache
    try:
        mtime = CATALOGUE.stat().st_mtime
    except FileNotFoundError:
        raise HTTPException(503, f"catalogue not built: {CATALOGUE} is missing")
    if _cache is None or _cache[0] != mtime:
        data = Catalogue.model_validate(json.loads(CATALOGUE.read_text()))
        prices = load_prices()
        for product in data.products:
            merge_price(product, prices)
        _cache = (mtime, data)
    return _cache[1]


# ── api ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Roomify catalogue", version="1")


@app.get("/api/catalogue", response_model=Catalogue)
def catalogue() -> Catalogue:
    return get_catalogue()


@app.get("/api/catalogue/products", response_model=list[Product])
def products(
    category: str | None = None,
    max_price: float | None = None,
    max_width_cm: float | None = Query(None, description="matches if ANY variant fits"),
) -> list[Product]:
    out = get_catalogue().products
    if category:
        out = [p for p in out if p.category == category]
    if max_price is not None:
        # unpriced items are excluded: the agent cannot budget what it cannot cost
        out = [p for p in out if p.price is not None and p.price <= max_price]
    if max_width_cm is not None:
        out = [p for p in out if any(
            v.dimensions and v.dimensions.width <= max_width_cm for v in p.variants)]
    return out


@app.get("/api/catalogue/products/{product_id}", response_model=Product)
def product(product_id: str) -> Product:
    for p in get_catalogue().products:
        if p.id == product_id:
            return p
    raise HTTPException(404, f"unknown product id: {product_id}")


# ── designs ──────────────────────────────────────────────────────────────────
# Shape comes from Model.exportSerialized() in src/model/model.ts. extra="allow"
# because the engine owns this shape and adds to it — validation here is a trust
# boundary, not a second definition of the format.
class DesignItem(BaseModel):
    model_config = ConfigDict(extra="allow", protected_namespaces=())

    item_name: str
    item_type: int
    model_url: str
    product_id: str | None = None     # the published id contract; absent on
    variant_id: str | None = None     # designs saved before it existed
    xpos: float
    ypos: float
    zpos: float
    rotation: float


class Design(BaseModel):
    model_config = ConfigDict(extra="allow")

    floorplan: dict
    items: list[DesignItem]


@app.post("/api/designs")
async def save_design(request: Request) -> dict:
    """Validate, then persist the bytes verbatim — a design is the engine's
    output, and re-serialising it here would be a chance to lose a field."""
    raw = await request.body()
    try:
        Design.model_validate_json(raw)
    except ValidationError as e:
        raise HTTPException(422, f"not a design: {e.errors()[0]}")
    DESIGNS.mkdir(parents=True, exist_ok=True)
    # ar-server.js's /current-design picks the highest-numbered design-*.json,
    # so the name is the contract between the two processes.
    name = f"design-{time.time_ns() // 1_000_000}.json"
    (DESIGNS / name).write_bytes(raw)
    return {"filename": name, "design_url": f"/models/{name}"}
