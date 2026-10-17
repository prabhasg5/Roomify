// The kernel against the old r69 engine's output (app/fixtures/*.golden.json, tools/dump-golden.mjs).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { fromDesign, toDesign, type LegacyDesign } from "./design";
import { cutsWall, findOpenings, holeRect } from "./openings";
import { findRooms } from "./rooms";
import type { PlacedItem, Vec3 } from "./types";
import { buildEdges, type HalfEdge } from "./walls";

const ROOT = path.join(__dirname, "../..");
const FIXTURES = path.join(ROOT, "app/fixtures");
const TOL = 0.01; // cm
const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".design.json")).map((f) => f.replace(".design.json", ""));
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));

// The golden's hole sizes came from the r69 model's bounding box (the catalogue's dimensions are
// rounded to 0.1 cm, too coarse for TOL), so read the same box from the model file.
function modelSize(item: PlacedItem): Vec3 {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, "example", item.modelUrl!), "utf8"));
  const s = json.scale ? 1 / json.scale : 1; // as r69 JSONLoader
  const v: number[] = json.vertices;
  const span = (k: number) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = k; i < v.length; i += 3) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    return (hi - lo) * s;
  };
  return { x: span(0), y: span(1), z: span(2) };
}

/** The kernel's output in the golden file's shape. */
function dump(legacy: LegacyDesign) {
  const design = fromDesign(legacy);
  const rooms = findRooms(design);
  const edges = buildEdges(design, rooms);
  const openings = findOpenings(design, edges);
  const sizes = new Map(design.items.map((it, i) => [i, cutsWall(it) ? modelSize(it) : null]));

  const edge = (e: HalfEdge | null) => e && {
    interiorStart: e.interiorStart, interiorEnd: e.interiorEnd,
    exteriorStart: e.exteriorStart, exteriorEnd: e.exteriorEnd,
    holes: openings.filter((o) => o.wall === e.wall).map((o) => {
      const it = design.items[o.item];
      return {
        item: o.item,
        interior: holeRect(it, sizes.get(o.item)!, e.interiorStart, e.interiorEnd),
        exterior: holeRect(it, sizes.get(o.item)!, e.exteriorStart, e.exteriorEnd),
      };
    }),
  };
  return {
    counts: { corners: design.corners.length, walls: design.walls.length, rooms: rooms.length, items: design.items.length },
    rooms: rooms.map((ids, i) => ({ corners: ids, interior: edges.rooms[i].map((e) => e.interiorStart) })),
    walls: design.walls.map((w, i) => ({
      start: w.start, end: w.end, thickness: w.thickness, height: w.height,
      front: edge(edges.walls[i].front), back: edge(edges.walls[i].back),
    })),
  };
}

/** Deep-equal, except numbers only need to agree within TOL. */
function expectClose(actual: unknown, expected: unknown, at = "$") {
  if (typeof expected === "number") {
    if (!(typeof actual === "number" && Math.abs(actual - expected) <= TOL)) {
      throw new Error(`${at}: got ${actual}, golden ${expected}`);
    }
  } else if (expected && typeof expected === "object") {
    expect(actual && typeof actual === "object", at).toBe(true);
    expect(Object.keys(actual as object).sort(), at).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) {
      expectClose((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${at}.${k}`);
    }
  } else {
    expect(actual, at).toBe(expected);
  }
}

describe.each(names)("%s", (name) => {
  const legacy: LegacyDesign = read(`${name}.design.json`);

  test("matches the r69 golden within 0.01 cm", () => {
    expectClose(dump(legacy), read(`${name}.golden.json`));
  });

  test("toDesign(fromDesign(x)) deep-equals x", () => {
    expect(toDesign(fromDesign(legacy))).toEqual(legacy);
  });
});

test("room detection on building-dwg takes < 200 ms", () => {
  const design = fromDesign(read("building-dwg.design.json"));
  const t = performance.now();
  findRooms(design);
  expect(performance.now() - t).toBeLessThan(200);
});
