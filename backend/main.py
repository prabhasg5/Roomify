"""Roomify backend — the catalogue, designs, and the AR view.

Serves 3d_room/example/catalogue.json (built by tools/build-catalogue.js) with
prices merged in from 2d_image_generation/epics.db, accepts saved designs, and
serves 3d_room/ar_view/ to the phone. The Pydantic models below ARE the schema:
a catalogue or a design that does not validate fails here rather than in the agent.

Product/variant ids are a PUBLISHED CONTRACT (saved designs record them) — this
service passes them through untouched and never derives its own.

Two processes, one app (uvicorn serves one protocol per process, and WebXR needs
HTTPS while the Vite proxy and curl want plain HTTP):

    uvicorn main:app --port 8080 --reload                    # desktop / Vite proxy
    uvicorn main:app --host 0.0.0.0 --port 8002 \
        --ssl-keyfile ../3d_room/ar_view/key.pem \
        --ssl-certfile ../3d_room/ar_view/cert.pem           # the phone

Both from this directory; `npm run dev` in 3d_room/ starts both.
"""

from __future__ import annotations

import json
import re
import socket
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, ValidationError

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "3d_room" / "example"
AR_VIEW = ROOT / "3d_room" / "ar_view"
CATALOGUE = EXAMPLE / "catalogue.json"
PRICE_DB = ROOT / "2d_image_generation" / "epics.db"
DESIGNS = AR_VIEW / "models"

# Baked into the QR code and /network-info, so they are the ports the phone is
# told to use. 8002 is the one the AR flow has always advertised.
HTTPS_PORT = 8002
HTTP_PORT = 8080


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
    # /current-design below picks the highest-numbered design-*.json.
    name = f"design-{time.time_ns() // 1_000_000}.json"
    (DESIGNS / name).write_bytes(raw)
    return {"filename": name, "design_url": f"/models/{name}"}


# ── AR view ──────────────────────────────────────────────────────────────────
# These are fetched SAME-ORIGIN over HTTPS by the phone from ar-mobile.html, so
# they could never move behind the Vite proxy (the phone cannot reach the dev
# machine's localhost, and an HTTPS page cannot fetch HTTP). They move when the
# pages themselves do — hence this file also serves ar_view/. Paths are exactly
# the ones ar-server.js used: the AR pages are served as-is, unmodified.
DESIGN_FILE = re.compile(r"design-\d+\.json")
SAFE_NAME = re.compile(r"[\w.-]+")
MAX_UPLOAD = 100 * 1024 * 1024
KEEP_MODELS = 10


def local_ip() -> str:
    """The address the phone can reach. Asking the routing table which interface
    leaves the machine beats picking the first non-loopback one — on a laptop
    with docker/VPN interfaces those are not the WiFi the phone is on."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))   # nothing is sent; UDP connect just routes
            return s.getsockname()[0]
        except OSError:
            return "localhost"


def created_at(path: Path):
    stat = path.stat()
    return getattr(stat, "st_birthtime", stat.st_mtime)


def uploaded_models() -> list[Path]:
    return sorted(DESIGNS.glob("*.glb"), key=created_at, reverse=True)


@app.get("/current-design")
def current_design() -> FileResponse:
    """The newest design on disk. Not an in-memory global: a restart used to lose
    the design and hand the phone a 404 with the files sitting right there."""
    designs = [p for p in DESIGNS.glob("design-*.json") if DESIGN_FILE.fullmatch(p.name)]
    if not designs:
        raise HTTPException(404, "No design saved")
    newest = max(designs, key=lambda p: int(p.stem.removeprefix("design-")))
    return FileResponse(newest, media_type="application/json")


@app.get("/design/{filename}")
def design(filename: str) -> FileResponse:
    # The name is joined onto a directory, so anything but a plain filename is an
    # attack: "." blocks ".." and dotfiles, SAFE_NAME blocks separators.
    if filename.startswith(".") or not SAFE_NAME.fullmatch(filename):
        raise HTTPException(404, "Design not found")
    path = DESIGNS / filename
    if not path.is_file():
        raise HTTPException(404, "Design not found")
    return FileResponse(path, media_type="application/json")


@app.get("/list-models")
def list_models() -> dict:
    return {"success": True, "models": [
        {"name": p.name, "url": f"/models/{p.name}",
         "created": datetime.fromtimestamp(created_at(p), timezone.utc).isoformat()}
        for p in uploaded_models()]}


@app.post("/upload-model")
async def upload_model(model: UploadFile = File(...)) -> dict:
    if Path(model.filename or "").suffix.lower() not in (".glb", ".gltf"):
        raise HTTPException(400, "Only GLB and GLTF files are allowed")
    DESIGNS.mkdir(parents=True, exist_ok=True)
    name = f"room-design-{time.time_ns() // 1_000_000}.glb"
    dest = DESIGNS / name
    written = 0
    try:
        with dest.open("wb") as out:
            while chunk := await model.read(1 << 20):
                written += len(chunk)
                if written > MAX_UPLOAD:
                    raise HTTPException(413, "Model exceeds the 100MB limit")
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    url = f"/models/{name}"
    origin = f"https://{local_ip()}:{HTTPS_PORT}"
    return {"success": True, "filename": name, "modelUrl": origin + url,
            "arUrl": f"{origin}/ar-view.html?model={quote(url)}"}


@app.post("/cleanup")
def cleanup() -> dict:
    stale = uploaded_models()[KEEP_MODELS:]
    for path in stale:
        path.unlink()
    return {"success": True, "deleted": len(stale)}


@app.get("/api/network-info")
def network_info() -> dict:
    """What to put in the QR code. Under /api so the editor reaches it through
    the Vite proxy same-origin — it is the one AR endpoint the desktop calls."""
    ip = local_ip()
    return {"ip": ip, "httpPort": HTTP_PORT, "httpsPort": HTTPS_PORT,
            "arUrl": f"https://{ip}:{HTTPS_PORT}/ar-mobile.html",
            "localUrl": f"http://localhost:{HTTP_PORT}/ar-mobile.html"}


# The AR pages live next to the TLS keypair this server is started with, and
# ar_view/ is served whole — so say no to those two names before the mount does.
@app.get("/key.pem")
@app.get("/cert.pem")
def no_keys() -> None:
    raise HTTPException(404, "Not Found")


# Static, last: a mount matches everything under its prefix, so every route above
# must already be registered. These four paths are what ar-mobile.html resolves
# model urls against — /glb and /js-models are the workspace's own asset folders,
# so both views read the same files.
DESIGNS.mkdir(parents=True, exist_ok=True)
app.mount("/models", StaticFiles(directory=DESIGNS))
app.mount("/glb", StaticFiles(directory=EXAMPLE / "models" / "glb"))
app.mount("/js-models", StaticFiles(directory=EXAMPLE / "models" / "js"))
app.mount("/three", StaticFiles(directory=EXAMPLE / "js"))
app.mount("/", StaticFiles(directory=AR_VIEW, html=True))
