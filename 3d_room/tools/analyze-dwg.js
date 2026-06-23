/**
 * analyze-dwg.js — inspect a real .dwg/.dxf plan so we can design wall extraction
 * against the actual layer structure (not guesses).
 *
 * Usage:  node tools/analyze-dwg.js /path/to/plan.dwg
 *
 * Prints: units, total entities, per-type counts, and a per-layer breakdown
 * (entity count + which entity types live on each layer + per-layer bbox).
 * Layers with lots of LINE/LWPOLYLINE and a wide bbox are usually the walls.
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node tools/analyze-dwg.js /path/to/plan.dwg');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('File not found: ' + file);
    process.exit(1);
  }

  const ext = path.extname(file).toLowerCase();
  let db;

  if (ext === '.dwg') {
    const { LibreDwg, Dwg_File_Type } = require('@mlightcad/libredwg-web');
    const wasmDir = path.join(__dirname, '..', 'node_modules', '@mlightcad', 'libredwg-web', 'wasm');
    const libredwg = await LibreDwg.create(wasmDir);
    const buf = fs.readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const dwg = libredwg.dwg_read_data(ab, Dwg_File_Type.DWG);
    db = libredwg.convert(dwg);
    libredwg.dwg_free(dwg);
  } else if (ext === '.dxf') {
    const DxfParser = require('dxf-parser').default || require('dxf-parser');
    const parser = new DxfParser();
    const parsed = parser.parseSync(fs.readFileSync(file, 'utf-8'));
    db = { header: parsed.header || {}, entities: parsed.entities || [] };
  } else {
    console.error('Unsupported extension: ' + ext);
    process.exit(1);
  }

  const entities = db.entities || [];
  const header = db.header || {};
  const insunits = header.INSUNITS != null ? header.INSUNITS : header['$INSUNITS'];

  console.log('=== FILE ===', path.basename(file));
  console.log('INSUNITS code:', insunits, '(1=in 2=ft 4=mm 5=cm 6=m, 0/undef=unitless)');
  console.log('Total entities:', entities.length);

  // Helpers to read coordinates from various entity shapes
  function pts(e) {
    const out = [];
    if (e.startPoint) out.push(e.startPoint);
    if (e.endPoint) out.push(e.endPoint);
    if (e.center) out.push(e.center);
    if (Array.isArray(e.vertices)) e.vertices.forEach(v => out.push(v));
    return out.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
  }

  // Per-type counts
  const byType = {};
  entities.forEach(e => { byType[e.type] = (byType[e.type] || 0) + 1; });
  console.log('\n=== ENTITY TYPES ===');
  Object.entries(byType).sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${t}: ${n}`));

  // Per-layer breakdown
  const layers = {};
  entities.forEach(e => {
    const L = e.layer || '0';
    const rec = layers[L] || (layers[L] = { count: 0, types: {}, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    rec.count++;
    rec.types[e.type] = (rec.types[e.type] || 0) + 1;
    pts(e).forEach(p => {
      if (p.x < rec.minX) rec.minX = p.x;
      if (p.x > rec.maxX) rec.maxX = p.x;
      if (p.y < rec.minY) rec.minY = p.y;
      if (p.y > rec.maxY) rec.maxY = p.y;
    });
  });

  console.log('\n=== LAYERS (sorted by entity count) ===');
  Object.entries(layers).sort((a, b) => b[1].count - a[1].count).forEach(([name, r]) => {
    const w = isFinite(r.maxX - r.minX) ? Math.round(r.maxX - r.minX) : 0;
    const h = isFinite(r.maxY - r.minY) ? Math.round(r.maxY - r.minY) : 0;
    const types = Object.entries(r.types).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}:${n}`).join(' ');
    console.log(`  "${name}"  count=${r.count}  bbox=${w}x${h}  [${types}]`);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
