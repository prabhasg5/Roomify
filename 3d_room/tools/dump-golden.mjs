// dump-golden.mjs — record the old r69 engine's geometry for every fixture design, so the
// stage-2 kernel (app/core/) can be tested against it.
//
// Usage:  npm run build && node tools/dump-golden.mjs
//
// Loads node_modules/three-r69 (r69, aliased) + example/js/blueprint3d.js in a vm context (only $.Callbacks is
// stubbed), loads each app/fixtures/*.design.json with model.loadSerialized(), and writes
// app/fixtures/<name>.golden.json:
//   rooms  — each room's corner ids + interior polygon (floorplan.ts findRooms + room.ts)
//   edges  — each half-edge's interior/exterior corners (half_edge.ts)
//   holes  — each wall item's hole rectangle on each half-edge plane (three/edge.ts makeWall)
// Output is rounded to 1e-6 cm. The old engine (src/, example/js/) is never modified.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(ROOT, "example");
export const FIXTURES = path.join(ROOT, "app", "fixtures");

// Minimal jQuery.Callbacks: the engine only uses add/remove/fire.
function Callbacks() {
  const fns = [];
  return {
    add(fn) { fns.push(fn); return this; },
    remove(fn) { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); return this; },
    fire(...args) { fns.slice().forEach((fn) => fn(...args)); return this; },
  };
}

// Same seeded PRNG every run, so any id the engine or importer mints is reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresh vm context with THREE r69 + BP3D (+ any extra example/js scripts). */
export function loadEngine(extraScripts = []) {
  const ctx = { console, $: { Callbacks } };
  ctx.self = ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext("Math.random = (" + mulberry32 + ")(1);", ctx);

  const run = (file, patch = (s) => s) =>
    vm.runInContext(patch(fs.readFileSync(file, "utf8")), ctx, { filename: file });
  run(path.join(ROOT, "node_modules/three-r69/three.js"));
  // ponytail: the golden is the reference for step 2, which drops the 150-corner room-detection
  // guard — so lift it here, in memory only, to get rooms for the big CAD plan too.
  run(path.join(EXAMPLE, "js/blueprint3d.js"), (s) => {
    const out = s.replace("maxCornersForRoomDetection = 150", "maxCornersForRoomDetection = Infinity");
    if (out === s) throw new Error("room-detection guard not found in blueprint3d.js");
    return out;
  });
  extraScripts.forEach((f) => run(path.join(EXAMPLE, "js", f)));

  // Read model files from disk instead of XHR, and skip materials (textures need a DOM).
  // Only the geometry matters here: its bounding box is the item's size.
  vm.runInContext(`THREE.JSONLoader.prototype.load = function (url, onLoad) {
    var json = JSON.parse(__readModel(url));
    delete json.materials;
    var r = this.parse(json, "");
    onLoad(r.geometry, r.materials || []);
  };`, Object.assign(ctx, { __readModel: (url) => fs.readFileSync(path.join(EXAMPLE, url), "utf8") }));
  return ctx;
}

const r6 = (n) => { const v = Math.round(n * 1e6) / 1e6; return v === 0 ? 0 : v; };
const pt = (p) => ({ x: r6(p.x), y: r6(p.y) });

function hole(item, transform, THREE) {
  // Mirrors three/edge.ts makeWall(): item position in the plane's frame ± halfSize.
  const pos = item.position.clone().applyMatrix4(transform);
  const h = item.halfSize;
  return { min: pt({ x: pos.x - h.x, y: pos.y - h.y }), max: pt({ x: pos.x + h.x, y: pos.y + h.y }) };
}

export function dumpDesign(designJson) {
  const ctx = loadEngine();
  const model = new ctx.BP3D.Model.Model("");
  model.loadSerialized(designJson);
  const fp = model.floorplan;
  const items = model.scene.getItems();
  const itemIndex = (it) => items.indexOf(it);

  return {
    counts: { corners: fp.getCorners().length, walls: fp.getWalls().length, rooms: fp.getRooms().length, items: items.length },
    rooms: fp.getRooms().map((room) => ({
      corners: room.corners.map((c) => c.id),
      interior: room.interiorCorners.map(pt),
    })),
    walls: fp.getWalls().map((w) => {
      const edge = (e) => e && {
        interiorStart: pt(e.interiorStart()), interiorEnd: pt(e.interiorEnd()),
        exteriorStart: pt(e.exteriorStart()), exteriorEnd: pt(e.exteriorEnd()),
        holes: w.items.map((it) => ({
          item: itemIndex(it),
          interior: hole(it, e.interiorTransform, ctx.THREE),
          exterior: hole(it, e.exteriorTransform, ctx.THREE),
        })),
      };
      return {
        start: w.getStart().id, end: w.getEnd().id,
        thickness: w.thickness, height: w.height,
        front: edge(w.frontEdge), back: edge(w.backEdge),
      };
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const designs = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".design.json")).sort();
  if (!designs.length) throw new Error("no *.design.json in " + FIXTURES);
  for (const f of designs) {
    const t = Date.now();
    const golden = dumpDesign(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
    const out = f.replace(".design.json", ".golden.json");
    fs.writeFileSync(path.join(FIXTURES, out), JSON.stringify(golden, null, 1) + "\n");
    console.log(out, JSON.stringify(golden.counts), Date.now() - t + " ms");
  }
}
