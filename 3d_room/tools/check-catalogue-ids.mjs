// Asserts every item in the "Add Items" panel resolves to a catalogue id.
//
// Designs save product_id + variant_id (src/model/model.ts) so a saved room
// survives an asset-pipeline change — mesh urls do not. example.js resolves
// those ids by looking the mesh url up in catalogue.json, so a catalogue
// regeneration that drops or renames a variant's `model` path silently starts
// saving items with no identity. This fails loudly instead.
//
// NOTE: this checks coverage, not id stability. Renaming an existing product or
// variant id still passes here but invalidates designs already saved with the old
// id — that needs a migration map, not a test.
//
// It also asserts every variant has a `glb` that exists and whose world-space
// bounding box is within 2% of the catalogue dimensions on each axis — the new
// renderer resolves furniture by id → glb, and placement/wall holes use those
// dimensions.
//
// Run: node tools/check-catalogue-ids.mjs [catalogue.json]   (npm run check:catalogue)
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = path.join(root, "example");
const catalogue = JSON.parse(
  await readFile(process.argv[2] || path.join(example, "catalogue.json"), "utf8")
);
const itemsJs = await readFile(path.join(root, "tools", "items.js"), "utf8");

const byModel = new Map();
for (const product of catalogue.products) {
  assert.ok(product.id, `product without an id: ${product.name}`);
  for (const variant of product.variants || []) {
    assert.ok(variant.id, `variant without an id in product ${product.id}`);
    if (variant.model) byModel.set(variant.model, `${product.id}/${variant.id}`);
  }
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const glbProblems = [];
for (const product of catalogue.products) {
  for (const variant of product.variants || []) {
    const id = `${product.id}/${variant.id}`;
    if (!variant.glb) { glbProblems.push(`${id}: no glb`); continue; }
    const file = path.join(example, variant.glb);
    if (!existsSync(file)) { glbProblems.push(`${id}: ${variant.glb} does not exist`); continue; }
    const { min, max } = getBounds((await io.read(file)).getRoot().listScenes()[0]);
    ["width", "height", "depth"].forEach((axis, i) => {
      const want = variant.dimensions?.[axis], got = max[i] - min[i];
      // ponytail: 0.05 cm floor because catalogue dimensions are rounded to 0.1 cm (rug is 0.5 cm tall)
      if (!(Math.abs(got - want) <= Math.max(0.02 * want, 0.05)))
        glbProblems.push(`${id}: ${axis} ${got.toFixed(1)} cm in ${variant.glb}, catalogue says ${want}`);
    });
  }
}
assert.deepEqual(glbProblems, [], `catalogue variants with a missing or mis-sized GLB:\n  ${glbProblems.join("\n  ")}`);

// The panel entries are object literals in items.js; the mesh url is what the
// runtime lookup keys on.
const panelModels = [...itemsJs.matchAll(/"model"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
assert.ok(panelModels.length > 0, "no panel items found in items.js");

const orphans = panelModels.filter((m) => !byModel.has(m));
assert.deepEqual(
  orphans,
  [],
  `panel items with no catalogue entry (they would save without identity):\n  ${orphans.join("\n  ")}`
);

console.log(
  `OK — ${panelModels.length} panel items resolve to catalogue ids ` +
    `(${catalogue.products.length} products, ${byModel.size} variants with meshes); ` +
    `every variant has a GLB within 2% of its dimensions`
);
