// build-fixtures.mjs — one-off: (re)build the stage-2 fixture designs in app/fixtures/ by
// driving the old engine the way the app does. Run dump-golden.mjs afterwards.
//
// Usage:  npm run build && node tools/build-fixtures.mjs [path/to/building001-0_floor1.dwg]
//
//   default-room   — the room example.js loads on start
//   house-dxf      — example/sample-plans/house.dxf through the CAD import dialog defaults
//   building-dwg   — the 627-wall DWG plan, same path (default: ~/Downloads/…)
//   furnished-room — default room + a door, a window and 6 items, added and dragged like the UI

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEngine, FIXTURES } from "./dump-golden.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(FIXTURES, "..", "..");
const write = (name, json) => {
  fs.writeFileSync(path.join(FIXTURES, name + ".design.json"), JSON.stringify(JSON.parse(json), null, 1) + "\n");
  console.log(name, "written");
};
fs.mkdirSync(FIXTURES, { recursive: true });

// 1. default room: the literal example.js passes to loadSerialized() on start.
const exampleJs = fs.readFileSync(path.join(ROOT, "example/js/example.js"), "utf8");
const DEFAULT_ROOM = exampleJs.match(/blueprint3d\.model\.loadSerialized\('(\{"floorplan".*?)'\);/)[1];
write("default-room", DEFAULT_ROOM);

// 2 + 3. CAD imports, with the defaults showCADSummary()/executeCADImport() pick:
// detected unit (else the dialog's "ft"), detected wall layers, "collapse double-line walls" on.
// parse(ctx) returns { entities, header } exactly as CADImporter.parseDxf / DWGImporter.parse do.
function importCad(name, parse) {
  const ctx = loadEngine(["dxf-parser.js", "cad-importer.js", "dwg-importer.js"]);
  const { entities, header } = parse(ctx);
  const unit = ctx.CADImporter.detectUnit(header) || "ft";
  const layers = ctx.CADImporter.detectWallLayers(entities).join(", ");
  const bp = ctx.CADImporter.entitiesToBlueprint(entities, unit, layers, { collapseWalls: true });
  console.log(name, { unit, layers, corners: Object.keys(bp.floorplan.corners).length, walls: bp.floorplan.walls.length });
  write(name, JSON.stringify(bp));
}
const dxf = fs.readFileSync(path.join(ROOT, "example/sample-plans/house.dxf"), "utf8");
importCad("house-dxf", (ctx) => ctx.CADImporter.parseDxf(dxf));

const dwgFile = process.argv[2] || path.join(os.homedir(), "Downloads/building001-0_floor1.dwg");
if (!fs.existsSync(dwgFile)) {
  console.error("DWG source missing, building-dwg not rebuilt: " + dwgFile);
} else {
  const { LibreDwg, Dwg_File_Type } = require("@mlightcad/libredwg-web");
  const libredwg = await LibreDwg.create(path.join(ROOT, "node_modules/@mlightcad/libredwg-web/wasm"));
  const buf = fs.readFileSync(dwgFile);
  const dwg = libredwg.dwg_read_data(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), Dwg_File_Type.DWG);
  const db = libredwg.convert(dwg);
  libredwg.dwg_free(dwg);
  // DWGImporter.parse() minus the browser wasm loading.
  importCad("building-dwg", (ctx) => ({
    entities: ctx.DWGImporter.normalizeEntities(db),
    header: { INSUNITS: db && db.header && db.header.INSUNITS },
  }));
}

// 4. furnished room: add items the way the "Add Items" panel does (no position), then move them
// like a drag: floor items by x/z, wall items with moveToPosition() onto a chosen wall edge.
const catalogue = JSON.parse(fs.readFileSync(path.join(ROOT, "example/catalogue.json"), "utf8")).products;
const ctx = loadEngine();
const model = new ctx.BP3D.Model.Model("");
model.loadSerialized(DEFAULT_ROOM);
const edgeAt = (x, y) => model.floorplan.wallEdges()
  .map((e) => ({ e, d: e.distanceTo(x, y) })).sort((a, b) => a.d - b.d)[0].e;

function add(productId, variantId, place) {
  const p = catalogue.find((p) => p.id === productId);
  const v = p.variants.find((v) => v.id === variantId);
  const before = model.scene.getItems().length;
  model.scene.addItem(p.item_type, v.model, {
    itemName: p.name, resizable: true, modelUrl: v.model, itemType: p.item_type,
    productId: p.id, variantId: v.id,
  });
  place(model.scene.getItems()[before]);
}
const onFloor = (x, z, rotY = 0) => (it) => { it.position.x = x; it.position.z = z; it.rotation.y = rotY; };
const onWall = (x, y, h) => (it) => {
  const edge = edgeAt(x, y);
  it.moveToPosition(new ctx.THREE.Vector3(x, h, y), { object: { edge } });
};

// Room spans x 204.85…672.21, y −178.31…289.05.
add("closed-door", "default", onWall(300, 289.052, 110));   // south wall
add("window", "default", onWall(672.211, 60, 150));         // east wall
add("sofa", "grey", onFloor(438, 220, Math.PI));
add("coffee-table", "wood", onFloor(438, 120));
add("blue-rug", "default", onFloor(438, 110));
add("floor-lamp", "default", onFloor(600, 240));
add("bookshelf", "default", onFloor(240, -100, Math.PI / 2));
add("chair", "blue", onFloor(560, 0, -Math.PI / 4));
write("furnished-room", model.exportSerialized());
