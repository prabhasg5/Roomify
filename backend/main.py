"""Roomify backend — the catalogue, designs, and the AR view.

Serves 3d_room/example/catalogue.json (built by tools/build-catalogue.js) with
prices merged in from backend/data/prices.db and uploaded models appended,
accepts model uploads and saved designs, and serves 3d_room/ar_view/ to the phone. The Pydantic models below ARE the schema:
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
import os
import re
import socket
import sqlite3
from struct import error as struct_error
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, ValidationError

import glb

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "3d_room" / "example"
AR_VIEW = ROOT / "3d_room" / "ar_view"
# The r69 script + Three.js JSON meshes ar-dynamic.html loads; AR-only, they go when AR is redone.
AR_LEGACY = ROOT / "3d_room" / "ar_legacy"
CATALOGUE = EXAMPLE / "catalogue.json"
PRICE_DB = Path(__file__).resolve().parent / "data" / "prices.db"
DESIGNS = AR_VIEW / "models"
# Uploaded models: <id>.glb as uploaded, its thumbnail, and uploads.json (their catalogue
# products). Under example/ so the app fetches them from Vite like the catalogue's own GLBs.
UPLOADS = EXAMPLE / "models" / "uploads"

# Baked into the QR code and /network-info, so they are the ports the phone is
# told to use. 8002 is the one the AR flow has always advertised.
HTTPS_PORT = 8002
HTTP_PORT = 8080


# ── schema (catalogue.json v1) ───────────────────────────────────────────────
class Dimensions(BaseModel):
    width: float
    height: float
    depth: float


class TextureSize(BaseModel):
    width: int | None
    height: int | None
    mime_type: str | None


class ModelStats(BaseModel):
    """Measured on upload, so the app can warn about a heavy model instead of altering it."""
    triangles: int
    textures: list[TextureSize]
    bytes: int


class Variant(BaseModel):
    id: str
    label: str
    model: str | None = None            # legacy r69 mesh; uploads have none
    glb: str | None = None
    unit_scale: float | None = None     # cm per GLB unit when not 1 (an upload stored as-is)
    stats: ModelStats | None = None
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
# prices.db lists priced items by shop name, the catalogue by mesh name, so an
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
_cache: tuple[tuple[float, float], Catalogue] | None = None


def uploads_file() -> Path:
    return UPLOADS / "uploads.json"


def load_uploads() -> list[dict]:
    """Uploaded products, plus {"id", "deleted"} for deleted ones: their ids stay taken."""
    f = uploads_file()
    return json.loads(f.read_text()) if f.exists() else []


def save_uploads(uploads: list[dict]) -> None:
    tmp = uploads_file().with_suffix(".tmp")
    tmp.write_text(json.dumps(uploads, indent=2))
    os.replace(tmp, uploads_file())


def get_catalogue() -> Catalogue:
    global _cache
    try:
        mtime = (CATALOGUE.stat().st_mtime,
                 uploads_file().stat().st_mtime if uploads_file().exists() else 0)
    except FileNotFoundError:
        raise HTTPException(503, f"catalogue not built: {CATALOGUE} is missing")
    if _cache is None or _cache[0] != mtime:
        data = Catalogue.model_validate(json.loads(CATALOGUE.read_text()))
        data.products += [Product.model_validate(p) for p in load_uploads() if "deleted" not in p]
        data.catalogue.product_count = len(data.products)   # what this response holds
        data.catalogue.variant_count = sum(len(p.variants) for p in data.products)
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


# ── model upload ─────────────────────────────────────────────────────────────
# The GLB is stored byte-identical to the upload: no simplify, no texture resize, no
# re-encode (stage 2 exists because a conversion changed how uploads look). The server
# only validates, measures and records; the app warns about heavy models.
MAX_MODEL = 100 * 1024 * 1024
MAX_THUMBNAIL = 5 * 1024 * 1024
PLACEMENT = {1: "floor", 2: "wall", 3: "in_wall", 7: "in_wall_floor", 8: "on_floor", 9: "wall_floor"}
SCALES = {"auto": None, "100": 100.0, "10": 10.0, "1": 1.0, "2.54": 2.54, "30.48": 30.48}
THUMB_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


async def read_capped(f: UploadFile, cap: int, what: str) -> bytes:
    data = bytearray()
    while chunk := await f.read(1 << 20):
        data += chunk
        if len(data) > cap:
            raise HTTPException(413, f"{what} exceeds the {cap // (1024 * 1024)} MB limit")
    return bytes(data)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


@app.post("/api/uploads", response_model=Product)
async def upload(
    model: UploadFile = File(...),
    name: str = Form(...),
    type: int = Form(1),
    scale: str = Form("auto", description="cm per model unit, or auto (old computeAutoScale)"),
    thumbnail: UploadFile | None = File(None, description="PNG/JPEG/WebP; the app renders one"),
) -> Product:
    """Add an uploaded model to the catalogue. Its product id is a published contract:
    designs save it, so it is assigned once here and never renamed."""
    name = name.strip()
    if not name or len(name) > 100:
        raise HTTPException(422, "Please enter a display name (at most 100 characters)")
    if type not in PLACEMENT:
        raise HTTPException(422, f"unknown item type {type}")
    if scale not in SCALES:
        raise HTTPException(422, f"unknown scale {scale!r}")
    data = await read_capped(model, MAX_MODEL, "Model")
    try:
        g = glb.Glb(data)
        lo, hi = g.bounds()
        stats = ModelStats(triangles=g.triangles(), textures=g.textures(), bytes=g.size)
    except glb.GlbError as e:
        raise HTTPException(422, str(e))
    except (KeyError, IndexError, TypeError, ValueError, struct_error) as e:
        raise HTTPException(422, f"GLB is malformed ({e.__class__.__name__}: {e})")
    size = [b - a for a, b in zip(lo, hi)]
    unit = SCALES[scale] or glb.auto_scale(size)
    thumb = await read_capped(thumbnail, MAX_THUMBNAIL, "Thumbnail") if thumbnail else b""
    ext = THUMB_EXT.get(glb.sniff(thumb)) if thumb else None
    if thumb and not ext:
        raise HTTPException(422, "Thumbnail must be a PNG, JPEG or WebP image")

    # No await from here on, so two uploads can't both claim one id (one event loop).
    # ponytail: single-process only; a lock or a db row if uploads ever run multi-worker.
    uploads = load_uploads()
    # A deleted upload's id stays taken, so a new upload never takes over designs that used it.
    taken = {p.id for p in get_catalogue().products} | {p["id"] for p in uploads}
    base = slug(name) or "upload"
    pid, n = base, 2
    while pid in taken:
        pid, n = f"{base}-{n}", n + 1
    UPLOADS.mkdir(parents=True, exist_ok=True)
    (UPLOADS / f"{pid}.glb").write_bytes(data)
    if ext:
        (UPLOADS / f"{pid}.{ext}").write_bytes(thumb)
    product = Product(
        id=pid, name=name, category="uncategorised", placement=PLACEMENT[type], item_type=type,
        variants=[Variant(
            id="default", label="Default", glb=f"models/uploads/{pid}.glb",
            thumbnail=f"models/uploads/{pid}.{ext}" if ext else None,
            dimensions=Dimensions(width=r1(size[0] * unit), height=r1(size[1] * unit), depth=r1(size[2] * unit)),
            unit_scale=unit if unit != 1 else None, stats=stats, source="upload",
        )],
    )
    uploads.append(product.model_dump(exclude_none=True, exclude={"price_min", "price_max", "price_source"}))
    save_uploads(uploads)
    return next(p for p in get_catalogue().products if p.id == pid)


@app.delete("/api/uploads/{product_id}")
def delete_upload(product_id: str) -> dict:
    """Old DELETE /api/models/:name: the GLB, its thumbnail and its catalogue entry go. Saved
    designs that use it still load and report the item as missing; the id is never reused."""
    uploads = load_uploads()
    i = next((i for i, p in enumerate(uploads) if p["id"] == product_id and "deleted" not in p), None)
    if i is None:
        raise HTTPException(404, f"no uploaded model {product_id!r}")  # built-ins can't be deleted
    for v in uploads[i]["variants"]:
        for url in (v.get("glb"), v.get("thumbnail")):
            if url:  # a plain file name inside UPLOADS, whatever the entry says
                (UPLOADS / Path(url).name).unlink(missing_ok=True)
    uploads[i] = {"id": product_id, "deleted": datetime.now(timezone.utc).isoformat()}
    save_uploads(uploads)
    return {"success": True, "message": f'Deleted "{product_id}"'}


def r1(n: float) -> float:
    """0.1 cm, as build-catalogue.js rounds the catalogue's dimensions."""
    return round(n * 10) / 10


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
# model urls against — /glb is the workspace's own catalogue folder, so both views
# read the same files; /js-models and /three are ar_legacy/ (ar-dynamic.html only).
DESIGNS.mkdir(parents=True, exist_ok=True)
app.mount("/models", StaticFiles(directory=DESIGNS))
app.mount("/glb", StaticFiles(directory=EXAMPLE / "models" / "glb"))
app.mount("/js-models", StaticFiles(directory=AR_LEGACY / "js-models"))
app.mount("/three", StaticFiles(directory=AR_LEGACY / "three"))
app.mount("/", StaticFiles(directory=AR_VIEW, html=True))
