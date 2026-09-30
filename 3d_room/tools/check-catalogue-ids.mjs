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
// Run: node tools/check-catalogue-ids.mjs   (npm run check:catalogue)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogue = JSON.parse(
  await readFile(path.join(root, "example", "catalogue.json"), "utf8")
);
const itemsJs = await readFile(path.join(root, "example", "js", "items.js"), "utf8");

const byModel = new Map();
for (const product of catalogue.products) {
  assert.ok(product.id, `product without an id: ${product.name}`);
  for (const variant of product.variants || []) {
    assert.ok(variant.id, `variant without an id in product ${product.id}`);
    if (variant.model) byModel.set(variant.model, `${product.id}/${variant.id}`);
  }
}

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
    `(${catalogue.products.length} products, ${byModel.size} variants with meshes)`
);
