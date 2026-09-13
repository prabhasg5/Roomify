// Asserts the dev server hands THREE.JSONLoader something it can actually parse.
//
// The models in example/models/js are Three.js JSON with a .js extension, so a
// plain Vite dev server transforms them and appends an inline sourcemap comment
// -> JSON.parse throws -> the loader never calls back -> the app hangs on
// "Loading...". vite.config.ts has a raw-json-models middleware to prevent that;
// this check fails if it ever stops working.
//
// Run: node tools/check-model-serving.mjs   (npm run check:models)
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.join(root, "..", "example", "models", "js");
const PORT = 5178;

const server = await createServer({
  configFile: path.join(root, "..", "vite.config.ts"),
  server: { open: false, port: PORT },
  logLevel: "error",
});
await server.listen();

try {
  const models = (await readdir(modelsDir)).filter((f) => f.endsWith(".js"));
  assert.ok(models.length > 0, "no model files found to check");

  for (const name of models) {
    const res = await fetch(`http://localhost:${PORT}/models/js/${name}`);
    assert.equal(res.status, 200, `${name}: HTTP ${res.status}`);
    const served = await res.text();
    const onDisk = await readFile(path.join(modelsDir, name), "utf8");
    assert.equal(served, onDisk, `${name}: served bytes differ from disk`);
    JSON.parse(served); // what THREE.JSONLoader does; throws on a sourcemap comment
  }
  console.log(`OK — ${models.length} models served raw and JSON-parseable`);
} finally {
  await server.close();
}
