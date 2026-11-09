"""The catalogue in SQLite — schema v3 (CATALOGUE_GUIDE.md §9, step C1).

One file, backend/data/catalogue.db (git-ignored), shared by both uvicorn processes: WAL, and
every write in a `begin immediate` transaction, so two writers serialise instead of racing.

It is created and seeded on first open from what existed before it: catalogue.json (the 21
built-ins, retailer `roomify`, ids UNCHANGED — saved designs record them), prices.db (merged in
once, at seed time) and uploads.json (retailer `upload`; a deleted upload is `discontinued`, so
its id stays taken). The seed runs once; after that the DB is the source of truth and
catalogue.json is only the app's offline fallback and `npm run check:catalogue`'s input.

Columns are derived (ingestion writes them: dimensions, stats, assets) or curated (review
writes them: category, room_types, placement_*, prices, attributes) — never both.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

TAXONOMY = json.loads((Path(__file__).parent / "taxonomy.json").read_text())
STATUSES = ("draft", "needs_review", "published", "rejected", "discontinued")

SCHEMA = f"""
create table if not exists retailers (
  id      text primary key,
  name    text not null,
  created text not null
);
-- path: the seeded and uploaded files stay where they live, ingest stores at models/assets/<sha256>.<ext>
-- (no semicolons in these comments: connect() splits SCHEMA on them)
create table if not exists assets (
  id             integer primary key,
  path           text not null unique,       -- url relative to 3d_room/example/
  kind           text not null check (kind in ('glb', 'thumbnail', 'texture', 'swatch')),
  sha256         text,                       -- null only if the file was missing at seed time
  license        text not null,
  source         text not null,
  source_url     text,
  attribution    text,
  non_commercial integer not null default 0 check (non_commercial in (0, 1))
);
create table if not exists products (
  id                text primary key,        -- published contract: never renamed, never deleted
  retailer_id       text not null references retailers(id),
  sku               text,
  status            text not null default 'draft' check (status in {STATUSES}),
  issues            text not null default '[]',   -- json list
  -- curated
  name              text not null,
  category          text not null,
  room_types        text not null default '[]',   -- json list, taxonomy room types
  style             text,
  item_type         integer not null,             -- engine code, app/core
  placement         text not null,
  placement_rule    text,
  facing_offset_deg real not null default 0,
  clearance         text,                         -- json {{front, sides, back}}
  price             real,
  price_min         real,
  price_max         real,
  price_source      text,
  currency          text not null default 'INR',
  created           text not null,
  updated           text not null,
  unique (retailer_id, sku)
);
create index if not exists products_browse on products (status, category);
create table if not exists geometry_variants (
  product_id      text not null references products(id),
  id              text not null,
  position        integer not null,
  label           text not null,
  glb_asset       integer references assets(id),
  thumbnail_asset integer references assets(id),
  model           text,                     -- legacy r69 mesh url: a lookup key for old designs only
  width real, height real, depth real,      -- cm, measured
  unit_scale      real,                     -- cm per GLB unit when not 1
  stats           text,                     -- json ModelStats
  price_delta     real not null default 0,
  source          text not null,
  attributes      text not null default '{{}}',
  primary key (product_id, id)
);
create table if not exists material_slots (
  product_id text not null references products(id),
  id         text not null,                 -- the material's name in the GLB
  position   integer not null,
  label      text not null,
  primary key (product_id, id)
);
create table if not exists material_options (
  product_id    text not null,
  slot_id       text not null,
  id            text not null,
  position      integer not null,
  label         text not null,
  texture_asset integer references assets(id),
  swatch_asset  integer references assets(id),
  factors       text not null default '{{}}',   -- json PBR factors
  price_delta   real not null default 0,
  attributes    text not null default '{{}}',
  primary key (product_id, slot_id, id),
  foreign key (product_id, slot_id) references material_slots(product_id, id)
)
"""

# Provenance of the seeded files. ponytail: the built-ins came with the Blueprint3D example and
# their license was never recorded, hence "unknown" — set it before any public demo.
BUILT_IN = {"license": "unknown", "source": "blueprint3d-example",
            "source_url": "https://github.com/furnishup/blueprint3d", "attribution": None,
            "non_commercial": 0}
UPLOADED = {"license": "unknown", "source": "upload", "source_url": None, "attribution": None,
            "non_commercial": 0}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── connection ───────────────────────────────────────────────────────────────
_ready: set[Path] = set()


def connect(path: Path, seed: Callable[[sqlite3.Connection], None]) -> sqlite3.Connection:
    """Autocommit connection (writes use tx()); the schema and seed on first use per process."""
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, isolation_level=None, timeout=10, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("pragma foreign_keys = on")
    if path not in _ready:
        con.execute("pragma journal_mode = wal")
        with tx(con):   # the other process may be seeding too: begin immediate serialises it
            for stmt in SCHEMA.split(";"):
                con.execute(stmt)
            if not con.execute("select 1 from retailers").fetchone():
                seed(con)
        _ready.add(path)
    return con


@contextmanager
def tx(con: sqlite3.Connection):
    con.execute("begin immediate")
    try:
        yield
        con.execute("commit")
    except BaseException:
        con.execute("rollback")
        raise


# ── price merge (seed only) ──────────────────────────────────────────────────
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


def load_prices(price_db: Path) -> dict[str, tuple[float, float]]:
    """{lowercased item name: (min, max)} — the same item is listed once per
    room type at different prices, so span every row for that name."""
    if not price_db.exists():
        return {}
    with sqlite3.connect(f"file:{price_db}?mode=ro", uri=True) as db:
        rows = db.execute(
            "select lower(name), min(price_min), max(price_max) "
            "from items group by lower(name)"
        ).fetchall()
    return {name: (lo, hi) for name, lo, hi in rows}


def merge_price(product: dict, prices: dict[str, tuple[float, float]]) -> None:
    """Fill price_min/max/price. A curated `price` always wins — derived flows up,
    curated is never overwritten."""
    key = product["name"].lower()
    if key in prices:
        source = product["name"]
    else:
        source = CATEGORY_PRICE_NAME.get(product["category"])
        key = source.lower() if source else None
    if key not in prices:
        return
    lo, hi = prices[key]
    product["price_min"], product["price_max"] = lo, hi
    product["price_source"] = f"epics:{source}"
    if product.get("price") is None:
        product["price"] = round((lo + hi) / 2)


# ── writes ───────────────────────────────────────────────────────────────────
def seed(con: sqlite3.Connection, catalogue: Path, price_db: Path, uploads: Path) -> None:
    t = now()
    con.executemany("insert into retailers values (?, ?, ?)",
                    [("roomify", "Roomify built-ins", t), ("upload", "Uploaded models", t)])
    prices = load_prices(price_db)
    for p in json.loads(catalogue.read_text())["products"]:
        merge_price(p, prices)
        insert_product(con, p, "roomify", BUILT_IN, lambda url: catalogue.parent / url)
    f = uploads / "uploads.json"
    for p in json.loads(f.read_text()) if f.exists() else []:
        if "deleted" in p:   # only the id survives; it stays taken
            con.execute("insert into products (id, retailer_id, status, name, category, item_type, "
                        "placement, created, updated) values (?, 'upload', 'discontinued', ?, "
                        "'uncategorised', 1, 'floor', ?, ?)", (p["id"], p["id"], p["deleted"], p["deleted"]))
        else:
            insert_product(con, p, "upload", UPLOADED, lambda url: uploads / Path(url).name)


def asset(con, path: str, kind: str, file: Path, provenance: dict) -> int:
    sha = hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None
    con.execute("insert or ignore into assets (path, kind, sha256, license, source, source_url, "
                "attribution, non_commercial) values (:path, :kind, :sha, :license, :source, "
                ":source_url, :attribution, :non_commercial)",
                {"path": path, "kind": kind, "sha": sha, **provenance})
    return con.execute("select id from assets where path = ?", (path,)).fetchone()[0]


def insert_product(con, p: dict, retailer: str, provenance: dict,
                   locate: Callable[[str], Path], status: str = "published") -> None:
    """p is the catalogue.json / API product shape (+ sku, issues, facing_offset_deg from
    ingestion). locate(url) is the file behind an asset url."""
    t = now()
    con.execute(
        "insert into products (id, retailer_id, sku, status, issues, name, category, room_types, style, "
        "item_type, placement, facing_offset_deg, price, price_min, price_max, price_source, created, updated) "
        "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (p["id"], retailer, p.get("sku"), status, json.dumps(p.get("issues", [])), p["name"], p["category"],
         json.dumps(p.get("room_types") or TAXONOMY["categories"].get(p["category"], {}).get("room_types", [])),
         p.get("style"), p["item_type"], p["placement"], p.get("facing_offset_deg", 0), p.get("price"), p.get("price_min"),
         p.get("price_max"), p.get("price_source"), t, t))
    for i, v in enumerate(p["variants"]):
        dims = v.get("dimensions") or {}
        con.execute(
            "insert into geometry_variants (product_id, id, position, label, glb_asset, "
            "thumbnail_asset, model, width, height, depth, unit_scale, stats, price_delta, source) "
            "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (p["id"], v["id"], i, v["label"],
             v.get("glb") and asset(con, v["glb"], "glb", locate(v["glb"]), provenance),
             v.get("thumbnail") and asset(con, v["thumbnail"], "thumbnail", locate(v["thumbnail"]), provenance),
             v.get("model"), dims.get("width"), dims.get("height"), dims.get("depth"),
             v.get("unit_scale"), v.get("stats") and json.dumps(v["stats"]),
             v.get("price_delta", 0), v["source"]))
    for i, slot in enumerate(p.get("material_slots") or []):
        con.execute("insert into material_slots values (?, ?, ?, ?)", (p["id"], slot["id"], i, slot["label"]))
        con.executemany(
            "insert into material_options (product_id, slot_id, id, position, label, factors, attributes) "
            "values (?, ?, ?, ?, ?, ?, ?)",
            [(p["id"], slot["id"], o["id"], j, o["label"], json.dumps(o.get("factors", {})),
              json.dumps(o.get("attributes", {}))) for j, o in enumerate(slot["options"])])


# ── reads ────────────────────────────────────────────────────────────────────
DIMENSIONS = ("width", "depth", "height")


def query(con, *, product_id: str | None = None, category: str | None = None,
          room_type: str | None = None, min_price: float | None = None,
          max_price: float | None = None, max_width: float | None = None,
          max_depth: float | None = None, max_height: float | None = None,
          limit: int | None = None, offset: int = 0) -> tuple[int, list[dict]]:
    """(total matching, one page of published products in the API shape), in seed/insert order.
    A price filter excludes unpriced products (the agent cannot budget what it cannot cost);
    size limits match if ONE variant fits all of them."""
    where, args = ["p.status = 'published'"], []
    for clause, value in (("p.id = ?", product_id), ("p.category = ?", category),
                          ("exists (select 1 from json_each(p.room_types) where value = ?)", room_type),
                          ("p.price >= ?", min_price), ("p.price <= ?", max_price)):
        if value is not None:
            where.append(clause)
            args.append(value)
    fits = [(d, v) for d, v in zip(DIMENSIONS, (max_width, max_depth, max_height)) if v is not None]
    if fits:
        where.append("exists (select 1 from geometry_variants v where v.product_id = p.id and "
                     + " and ".join(f"v.{d} <= ?" for d, _ in fits) + ")")
        args += [v for _, v in fits]
    w = " and ".join(where)
    total = con.execute(f"select count(*) from products p where {w}", args).fetchone()[0]
    rows = con.execute(f"select * from products p where {w} order by p.rowid limit ? offset ?",
                       [*args, -1 if limit is None else limit, offset]).fetchall()
    ids = json.dumps([r["id"] for r in rows])

    variants: dict[str, list] = {}
    for v in con.execute(
            "select v.*, g.path glb, t.path thumbnail from geometry_variants v "
            "left join assets g on g.id = v.glb_asset left join assets t on t.id = v.thumbnail_asset "
            "where v.product_id in (select value from json_each(?)) order by v.position", (ids,)):
        variants.setdefault(v["product_id"], []).append({
            "id": v["id"], "label": v["label"], "model": v["model"], "glb": v["glb"],
            "thumbnail": v["thumbnail"], "unit_scale": v["unit_scale"],
            "stats": v["stats"] and json.loads(v["stats"]),
            "dimensions": None if v["width"] is None else {d: v[d] for d in DIMENSIONS},
            "price_delta": v["price_delta"], "source": v["source"],
            "attributes": json.loads(v["attributes"])})

    options: dict[tuple, list] = {}
    for o in con.execute(
            "select o.*, t.path texture, s.path swatch from material_options o "
            "left join assets t on t.id = o.texture_asset left join assets s on s.id = o.swatch_asset "
            "where o.product_id in (select value from json_each(?)) order by o.position", (ids,)):
        options.setdefault((o["product_id"], o["slot_id"]), []).append({
            "id": o["id"], "label": o["label"], "texture": o["texture"], "swatch": o["swatch"],
            "factors": json.loads(o["factors"]), "price_delta": o["price_delta"],
            "attributes": json.loads(o["attributes"])})
    slots: dict[str, list] = {}
    for s in con.execute("select * from material_slots where product_id in "
                         "(select value from json_each(?)) order by position", (ids,)):
        slots.setdefault(s["product_id"], []).append(
            {"id": s["id"], "label": s["label"], "options": options.get((s["product_id"], s["id"]), [])})

    return total, [{
        "id": r["id"], "retailer": r["retailer_id"], "name": r["name"], "category": r["category"],
        "room_types": json.loads(r["room_types"]), "style": r["style"], "price": r["price"],
        "price_min": r["price_min"], "price_max": r["price_max"], "price_source": r["price_source"],
        "currency": r["currency"], "placement": r["placement"], "item_type": r["item_type"],
        "variants": variants.get(r["id"], []), "material_slots": slots.get(r["id"], []),
    } for r in rows]
