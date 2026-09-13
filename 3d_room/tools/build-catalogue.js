#!/usr/bin/env node
/**
 * Builds example/catalogue.json — the structured product catalogue the AI
 * furnishing agent selects from.
 *
 * Sources (all existing, nothing new authored by hand):
 *   example/js/items.js            → the 25 built-in entries
 *   example/models/user-models.json → user-uploaded models
 *   example/models/js/*.js          → the meshes, for REAL dimensions
 *
 * Dimensions are measured, not guessed: Three.js JSON v3.1 stores raw vertices
 * plus a `scale` divisor, so actual_cm = vertex_range / scale. Verified against
 * cb-blue-block-60x96.js → 152.4 × 243.8 cm = exactly 60" × 96".
 *
 * price and style are seeded null — they are a human/product decision, not
 * something derivable from a mesh. Fill them in catalogue.json directly.
 *
 * Usage: node tools/build-catalogue.js [--report]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'example');
const MODELS_JS = path.join(EXAMPLE, 'models', 'js');
const OUT = path.join(EXAMPLE, 'catalogue.json');

// ── placement types, straight from src/items/factory.ts ──────────────────────
const PLACEMENT = {
  1: 'floor',        // free-standing on the floor
  2: 'wall',         // hangs on a wall (art, mirrors)
  3: 'in_wall',      // cut into a wall (windows)
  7: 'in_wall_floor',// cut into a wall, meets floor (doors)
  8: 'on_floor',     // lies flat, other items may overlap it (rugs)
  9: 'wall_floor'
};

// ── category inference: first match wins. Extend as the catalogue grows. ─────
const CATEGORY_RULES = [
  [/\bdoor\b/i,                'door'],
  [/\bwindow\b/i,              'window'],
  [/\brug\b|\bcarpet\b/i,      'rug'],
  [/\bposter\b|\bart\b|\bpainting\b/i, 'wall_art'],
  [/\bsofa\b|\bsectional\b|\bcouch\b|\bloveseat\b/i, 'sofa'],
  [/\bbed\b(?!side)/i,         'bed'],
  [/\bbedside\b|\bnightstand\b/i, 'nightstand'],
  [/\bdresser\b|\bwardrobe\b|\bcloset\b/i, 'storage'],
  [/\bbookshelf\b|\bbookcase\b|\bshelf\b/i, 'shelving'],
  [/\bmedia console\b|\btv stand\b/i, 'media_unit'],
  [/\bdining table\b/i,        'dining_table'],
  [/\bcoffee table\b/i,        'coffee_table'],
  [/\bside table\b|\bend table\b/i, 'side_table'],
  [/\btable\b/i,               'table'],
  [/\bchair\b|\barmchair\b|\brecliner\b|\bstool\b|\bbench\b/i, 'chair'],
  [/\blamp\b|\blight\b/i,      'lighting'],
  [/\btrunk\b|\bchest\b/i,     'storage'],
];

function categoryOf(name) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return 'uncategorised';
}

// ── variant grouping ─────────────────────────────────────────────────────────
// The existing catalogue ALREADY contains variants, flattened into separate
// entries: "Dresser - Dark Wood" / "Dresser - White". Splitting on " - " gives
// product + variant for free. Colour-prefix names need an explicit nudge.
const PREFIX_VARIANTS = [
  { match: /^(Red|Blue|Green|Black|White|Grey|Gray) (Chair)$/i, product: 'Chair' },
];

function splitVariant(name) {
  const dash = name.split(/\s+-\s+/);
  if (dash.length === 2) return { product: dash[0].trim(), variant: dash[1].trim() };

  for (const rule of PREFIX_VARIANTS) {
    const m = name.match(rule.match);
    if (m) return { product: rule.product, variant: m[1] };
  }
  return { product: name.trim(), variant: 'Default' };
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── measure a mesh ───────────────────────────────────────────────────────────
// Three.js JSONLoader divides vertices by `scale`, so that is the cm conversion.
function measure(modelRelPath) {
  const file = path.join(EXAMPLE, modelRelPath);
  if (!fs.existsSync(file)) return { dimensions: null, note: 'model file missing' };
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return { dimensions: null, note: 'unparseable model file' };
  }
  const v = json.vertices;
  if (!Array.isArray(v) || v.length < 3) return { dimensions: null, note: 'no vertex data' };

  const s = json.scale || 1.0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < v.length; i += 3) {
    if (v[i]   < minX) minX = v[i];   if (v[i]   > maxX) maxX = v[i];
    if (v[i+1] < minY) minY = v[i+1]; if (v[i+1] > maxY) maxY = v[i+1];
    if (v[i+2] < minZ) minZ = v[i+2]; if (v[i+2] > maxZ) maxZ = v[i+2];
  }
  const r1 = n => Math.round(n * 10) / 10;
  return {
    dimensions: {                    // centimetres, matching the engine's unit
      width:  r1((maxX - minX) / s), // x — same axis as Item.getWidth()
      height: r1((maxY - minY) / s), // y — Item.getHeight()
      depth:  r1((maxZ - minZ) / s)  // z — Item.getDepth()
    },
    note: null
  };
}

// ── read the two existing sources ────────────────────────────────────────────
function readBuiltIns() {
  const src = fs.readFileSync(path.join(EXAMPLE, 'js', 'items.js'), 'utf-8');
  const live = src.replace(/\/\*[\s\S]*?\*\//g, '');   // drop commented-out entries
  const decl = live.search(/var\s+items\s*=\s*\[/);
  if (decl === -1) throw new Error('could not locate `var items = [` in items.js');
  const start = live.indexOf('[', decl);
  // Bracket-match to the array's real end — items.js has more code after it.
  let depth = 0, end = -1;
  for (let i = start; i < live.length; i++) {
    const ch = live[i];
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) { end = i; break; }
  }
  if (end === -1) throw new Error('unterminated items array');
  // Local, trusted, build-time file — a Function eval is the honest short path.
  return new Function('return ' + live.slice(start, end + 1))();
}

function readUploads() {
  const f = path.join(EXAMPLE, 'models', 'user-models.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : [];
}

// ── build ────────────────────────────────────────────────────────────────────
function build() {
  const warn = m => console.warn(`   ⚠ ${m}`);
  const raw = [];

  for (const it of readBuiltIns()) {
    if (!it || !it.name || !it.model) continue;
    raw.push({ name: it.name, image: it.image, model: it.model, glb: it.glb || null,
               type: String(it.type || 1), source: 'built-in' });
  }
  for (const it of readUploads()) {
    if (!it || !it.name || !it.model) continue;
    raw.push({ name: it.name, image: it.image, model: it.model, glb: it.glb || null,
               type: String(it.type || 1), source: 'upload' });
  }

  // Case-insensitive duplicate detection (there are real ones: "Dining Table"
  // and "Dining table" are two entries pointing at different meshes).
  const byLower = {};
  for (const r of raw) (byLower[r.name.toLowerCase()] ||= []).push(r);
  for (const [k, group] of Object.entries(byLower)) {
    if (group.length > 1) warn(`duplicate name "${group[0].name}" ×${group.length} — differing only by case; merged as variants`);
  }

  // Group into products
  const products = new Map();
  for (const r of raw) {
    const { product, variant } = splitVariant(r.name);
    const id = slug(product);
    if (!products.has(id)) {
      products.set(id, {
        id,
        name: product,
        category: categoryOf(product + ' ' + r.name),
        style: null,          // ← curate: scandinavian | modern | traditional | industrial ...
        price: null,          // ← curate: numeric, in your display currency
        placement: PLACEMENT[r.type] || 'floor',
        item_type: Number(r.type),
        variants: []
      });
    }
    const p = products.get(id);
    const { dimensions, note } = measure(r.model);
    if (note) warn(`${r.name}: ${note}`);

    // Disambiguate colliding variant labels (the case-duplicate pair).
    let label = variant;
    let n = 2;
    while (p.variants.some(v => v.label.toLowerCase() === label.toLowerCase())) label = `${variant} ${n++}`;

    p.variants.push({
      id: slug(label),
      label,
      model: r.model,
      glb: r.glb,
      thumbnail: r.image || null,
      dimensions,               // measured from the mesh, in cm
      price_delta: 0,           // ← curate if variants differ in price
      source: r.source
    });
  }

  const list = [...products.values()].sort((a, b) =>
    a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  return {
    catalogue: {
      version: 1,
      generated: new Date().toISOString(),
      generator: 'tools/build-catalogue.js',
      units: 'cm',
      note: 'dimensions are measured from mesh geometry; price and style are curated by hand',
      product_count: list.length,
      variant_count: list.reduce((n, p) => n + p.variants.length, 0)
    },
    products: list
  };
}

function main() {
  const out = build();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const c = out.catalogue;
  console.log(`\n✅ ${path.relative(ROOT, OUT)}`);
  console.log(`   ${c.product_count} products, ${c.variant_count} variants`);

  const missing = out.products.flatMap(p =>
    p.variants.filter(v => !v.dimensions).map(v => `${p.name} / ${v.label}`));
  if (missing.length) console.log(`   ⚠ no dimensions for: ${missing.join(', ')}`);

  const byCat = {};
  for (const p of out.products) (byCat[p.category] ||= []).push(p.name);
  console.log('\n   by category:');
  for (const [cat, names] of Object.entries(byCat).sort())
    console.log(`     ${cat.padEnd(16)} ${names.length}  (${names.join(', ')})`);

  const gaps = ['bed', 'sofa', 'chair', 'dining_table', 'coffee_table', 'nightstand',
                'storage', 'shelving', 'lighting', 'rug'].filter(c => !byCat[c]);
  if (gaps.length) console.log(`\n   ⚠ empty categories (agent cannot furnish these): ${gaps.join(', ')}`);

  console.log(`\n   next: fill in "style" and "price" in ${path.basename(OUT)} — everything else is derived.\n`);
}

if (require.main === module) main();
module.exports = { build, measure, splitVariant, categoryOf };
