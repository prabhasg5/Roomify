"""Roomify backend — the catalogue, designs, and the AR view.

Serves the catalogue from SQLite (catalogue/db.py: backend/data/catalogue.db, seeded once
from 3d_room/example/catalogue.json, backend/data/prices.db and uploads.json),
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

import re
import socket
import time
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, ValidationError

import glb
from catalogue import db, ingest

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "3d_room" / "example"
AR_VIEW = ROOT / "3d_room" / "ar_view"
# The r69 script + Three.js JSON meshes ar-dynamic.html loads; AR-only, they go when AR is redone.
AR_LEGACY = ROOT / "3d_room" / "ar_legacy"
CATALOGUE = EXAMPLE / "catalogue.json"
PRICE_DB = Path(__file__).resolve().parent / "data" / "prices.db"     # seed only
CATALOGUE_DB = Path(__file__).resolve().parent / "data" / "catalogue.db"
DESIGNS = AR_VIEW / "models"
# Uploaded models: <id>.glb as uploaded and its thumbnail (their products are in the DB,
# retailer `upload`; a pre-DB uploads.json here is read once, by the seed). Under example/ so the app fetches them from Vite like the catalogue's own GLBs.
UPLOADS = EXAMPLE / "models" / "uploads"

# Baked into the QR code and /network-info, so they are the ports the phone is
# told to use. 8002 is the one the AR flow has always advertised.
HTTPS_PORT = 8002
HTTP_PORT = 8080


# ── schema (API shape of catalogue v3) ────────────────────────────────────────────
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
    attributes: dict = {}


class MaterialOption(BaseModel):
    id: str
    label: str
    texture: str | None = None
    swatch: str | None = None
    factors: dict = {}
    price_delta: float = 0
    attributes: dict = {}


class MaterialSlot(BaseModel):
    id: str
    label: str
    options: list[MaterialOption]


class Product(BaseModel):
    id: str
    retailer: str | None = None
    name: str
    category: str
    room_types: list[str] = []
    style: str | None = None
    price: float | None = None          # curated, else seeded from the price db
    price_min: float | None = None
    price_max: float | None = None
    price_source: str | None = None
    currency: str = "INR"
    placement: str
    item_type: int
    variants: list[Variant]
    material_slots: list[MaterialSlot] = []


class Meta(BaseModel):
    version: int
    generated: str
    generator: str
    units: str
    note: str | None = None
    total: int                          # matching the filters; products is one page of them
    product_count: int
    variant_count: int


class Catalogue(BaseModel):
    catalogue: Meta
    products: list[Product]


# ── api ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Roomify catalogue", version="3")


@contextmanager
def catalogue_db():
    seed = lambda con: db.seed(con, CATALOGUE, PRICE_DB, UPLOADS)
    with closing(db.connect(CATALOGUE_DB, seed)) as con:
        yield con


def vocab(kind: str, value: str | None, what: str) -> str | None:
    """A filter outside the taxonomy is a typo, not an empty result."""
    if value is not None and value not in db.TAXONOMY[kind]:
        raise HTTPException(422, f"unknown {what} {value!r}")
    return value


def filters(
    category: str | None = None,
    room_type: str | None = None,
    min_price: float | None = None,
    max_price: float | None = Query(None, description="unpriced products are excluded"),
    max_width_cm: float | None = Query(None, description="size limits match if ONE variant fits all"),
    max_depth_cm: float | None = None,
    max_height_cm: float | None = None,
    limit: int | None = Query(None, ge=1, description="omitted = everything (what the app loads)"),
    offset: int = Query(0, ge=0),
) -> dict:
    return {"category": vocab("categories", category, "category"),
            "room_type": vocab("room_types", room_type, "room type"),
            "min_price": min_price, "max_price": max_price, "max_width": max_width_cm,
            "max_depth": max_depth_cm, "max_height": max_height_cm, "limit": limit, "offset": offset}


@app.get("/api/catalogue", response_model=Catalogue)
def catalogue(f: dict = Depends(filters)) -> Catalogue:
    with catalogue_db() as con:
        total, products = db.query(con, **f)
    return Catalogue(
        catalogue=Meta(version=3, generated=db.now(), generator="backend/catalogue/db.py",
                       units="cm", note="SQLite catalogue; dimensions measured, prices curated",
                       total=total, product_count=len(products),
                       variant_count=sum(len(p["variants"]) for p in products)),
        products=products)


@app.get("/api/catalogue/products", response_model=list[Product])
def products(f: dict = Depends(filters)) -> list[dict]:
    with catalogue_db() as con:
        return db.query(con, **f)[1]


@app.get("/api/catalogue/products/{product_id}", response_model=Product)
def product(product_id: str) -> dict:
    with catalogue_db() as con:
        found = db.query(con, product_id=product_id)[1]
    if not found:
        raise HTTPException(404, f"unknown product id: {product_id}")
    return found[0]


# ── model upload ─────────────────────────────────────────────────────────────
# The GLB is stored byte-identical to the upload: no simplify, no texture resize, no
# re-encode (stage 2 exists because a conversion changed how uploads look). It goes through
# ingestion's stages 1–4 (catalogue/ingest.py) like any retailer's model; unlike theirs it is
# published at once, its issues recorded but not blocking: it is the user's own model.
MAX_MODEL = 100 * 1024 * 1024
MAX_THUMBNAIL = 5 * 1024 * 1024
SCALES = {"auto": None, "100": 100.0, "10": 10.0, "1": 1.0, "2.54": 2.54, "30.48": 30.48}
THUMB_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


async def read_capped(f: UploadFile, cap: int, what: str) -> bytes:
    data = bytearray()
    while chunk := await f.read(1 << 20):
        data += chunk
        if len(data) > cap:
            raise HTTPException(413, f"{what} exceeds the {cap // (1024 * 1024)} MB limit")
    return bytes(data)


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
    if type not in ingest.PLACEMENT:
        raise HTTPException(422, f"unknown item type {type}")
    if scale not in SCALES:
        raise HTTPException(422, f"unknown scale {scale!r}")
    data = await read_capped(model, MAX_MODEL, "Model")
    try:
        p = ingest.inspect(data, scale=SCALES[scale])   # no declared size, so never re-rooted
    except ingest.Rejected as e:
        raise HTTPException(422, str(e))
    thumb = await read_capped(thumbnail, MAX_THUMBNAIL, "Thumbnail") if thumbnail else b""
    ext = THUMB_EXT.get(glb.sniff(thumb)) if thumb else None
    if thumb and not ext:
        raise HTTPException(422, "Thumbnail must be a PNG, JPEG or WebP image")

    # The id is picked and inserted in one `begin immediate`: the other uvicorn process
    # writes this DB too. A deleted upload's id stays taken (its row is discontinued), so a
    # new upload never takes over designs that used it.
    base = ingest.slug(name) or "upload"
    with catalogue_db() as con:
        with db.tx(con):
            pid, n = base, 2
            while con.execute("select 1 from products where id = ?", (pid,)).fetchone():
                pid, n = f"{base}-{n}", n + 1
            UPLOADS.mkdir(parents=True, exist_ok=True)
            (UPLOADS / f"{pid}.glb").write_bytes(p.pop("data"))
            if ext:
                (UPLOADS / f"{pid}.{ext}").write_bytes(thumb)
            p.update(id=pid, name=name, placement=ingest.PLACEMENT[type], item_type=type)
            p["variants"][0].update(glb=f"models/uploads/{pid}.glb", source="upload",
                                    thumbnail=f"models/uploads/{pid}.{ext}" if ext else None)
            db.insert_product(con, p, "upload", db.UPLOADED, lambda url: UPLOADS / Path(url).name)
        return db.query(con, product_id=pid)[1][0]


@app.delete("/api/uploads/{product_id}")
def delete_upload(product_id: str) -> dict:
    """Old DELETE /api/models/:name: the GLB and its thumbnail go, the product is discontinued.
    Saved designs that use it still load and report the item as missing; the id is never reused."""
    with catalogue_db() as con, db.tx(con):
        urls = con.execute(
            "select a.path from products p join geometry_variants v on v.product_id = p.id "
            "join assets a on a.id in (v.glb_asset, v.thumbnail_asset) "
            "where p.id = ? and p.retailer_id = 'upload' and p.status != 'discontinued'",
            (product_id,)).fetchall()
        updated = con.execute(
            "update products set status = 'discontinued', updated = ? "
            "where id = ? and retailer_id = 'upload' and status != 'discontinued'",
            (db.now(), product_id)).rowcount
        if not updated:
            raise HTTPException(404, f"no uploaded model {product_id!r}")  # built-ins can't be deleted
        for (url,) in urls:  # a plain file name inside UPLOADS, whatever the row says
            (UPLOADS / Path(url).name).unlink(missing_ok=True)
    return {"success": True, "message": f'Deleted "{product_id}"'}


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
