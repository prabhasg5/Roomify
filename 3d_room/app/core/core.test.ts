// The kernel against the old r69 engine's output (app/fixtures/*.golden.json, tools/dump-golden.mjs).

import fs from "node:fs";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";
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
// rounded to 0.1 cm, too coarse for TOL). The catalogue GLBs were written from those same vertices
// (step 3, float32 ≈ 1e-5 cm), so read the box from the item's GLB, as the renderer does.
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const catalogue: { products: { id: string; variants: { id: string; glb: string }[] }[] } =
  JSON.parse(fs.readFileSync(path.join(ROOT, "example/catalogue.json"), "utf8"));
const glbOf = new Map(catalogue.products.flatMap((p) => p.variants.map((v) => [`${p.id}/${v.id}`, v.glb])));
const boxes = new Map<string, Vec3>();
for (const it of names.flatMap((n) => fromDesign(read(`${n}.design.json`)).items).filter(cutsWall)) {
  const key = `${it.productId}/${it.variantId}`;
  if (boxes.has(key)) continue;
  const { min, max } = getBounds((await io.read(path.join(ROOT, "example", glbOf.get(key)!))).getRoot().listScenes()[0]);
  boxes.set(key, { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] });
}
const modelSize = (item: PlacedItem): Vec3 => boxes.get(`${item.productId}/${item.variantId}`)!;

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
