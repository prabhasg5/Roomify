// The ESM importers reproduce the fixtures the old importers built (tools/build-fixtures.mjs):
// same dialog defaults (detected unit, else ft; detected wall layers; collapse on) and the same
// seeded Math.random, so even the corner ids come out identical and the designs compare whole.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CADImporter } from "./cad-importer.js";
import { DWGImporter } from "./dwg-importer.js";
import type { CadEntity, CadHeader } from "./cad-importer";

const ROOT = path.join(__dirname, "../..");
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, `app/fixtures/${name}.design.json`), "utf8"));

// tools/dump-golden.mjs's PRNG, seeded 1 per import as build-fixtures' fresh engine context is.
// Loading r69 + blueprint3d.js in that context drew 21 numbers (UUIDs) before the importer ran.
const ENGINE_LOAD_DRAWS = 21;
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = Math.random;
beforeEach(() => {
  Math.random = mulberry32(1);
  for (let i = 0; i < ENGINE_LOAD_DRAWS; i++) Math.random();
});
afterEach(() => { Math.random = random; });

const importWithDefaults = ({ entities, header }: { entities: CadEntity[]; header: CadHeader }) =>
  CADImporter.entitiesToBlueprint(entities, CADImporter.detectUnit(header) || "ft", CADImporter.detectWallLayers(entities).join(", "), { collapseWalls: true });

test("house.dxf imports to the house-dxf fixture", () => {
  const dxf = fs.readFileSync(path.join(ROOT, "example/sample-plans/house.dxf"), "utf8");
  expect(importWithDefaults(CADImporter.parseDxf(dxf))).toEqual(fixture("house-dxf"));
});

const DWG = path.join(os.homedir(), "Downloads/building001-0_floor1.dwg");
test.skipIf(!fs.existsSync(DWG))("building001-0_floor1.dwg imports to the building-dwg fixture (skipped without the file)", async () => {
  const buf = fs.readFileSync(DWG);
  const parsed = await DWGImporter.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), path.join(ROOT, "node_modules/@mlightcad/libredwg-web/wasm"));
  expect(importWithDefaults(parsed)).toEqual(fixture("building-dwg"));
}, 60_000);
