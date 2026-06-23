/**
 * proto-walls.js — offline prototype of the double-line → centerline wall
 * extraction, measured against a real plan before wiring into the importer.
 *
 * Usage: node tools/proto-walls.js /path/to/plan.dwg [wallLayerRegex]
 */
const fs = require('fs');
const path = require('path');

const INCH_TO_CM = 2.54;

async function loadEntities(file) {
  const { LibreDwg, Dwg_File_Type } = require('@mlightcad/libredwg-web');
  const wasmDir = path.join(__dirname, '..', 'node_modules', '@mlightcad', 'libredwg-web', 'wasm');
  const libredwg = await LibreDwg.create(wasmDir);
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dwg = libredwg.dwg_read_data(ab, Dwg_File_Type.DWG);
  const db = libredwg.convert(dwg);
  libredwg.dwg_free(dwg);
  return db;
}

// Pull straight segments (cm) from LINE + LWPOLYLINE on matching layers.
function segmentsFromEntities(entities, layerRe, scale) {
  const segs = [];
  entities.forEach(e => {
    if (!layerRe.test(e.layer || '')) return;
    if (e.type === 'LINE' && e.startPoint && e.endPoint) {
      segs.push(mk(e.startPoint, e.endPoint, scale));
    } else if (e.type === 'LWPOLYLINE' && Array.isArray(e.vertices)) {
      for (let i = 0; i < e.vertices.length - 1; i++) {
        segs.push(mk(e.vertices[i], e.vertices[i + 1], scale));
      }
      if (e.flag & 1 && e.vertices.length > 2) {
        segs.push(mk(e.vertices[e.vertices.length - 1], e.vertices[0], scale));
      }
    }
  });
  return segs.filter(s => s.len > 1); // drop sub-1cm noise
}

function mk(a, b, scale) {
  const x1 = a.x * scale, y1 = a.y * scale, x2 = b.x * scale, y2 = b.y * scale;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  return { x1, y1, x2, y2, dx, dy, len, ang: Math.atan2(dy, dx) };
}

// angle difference mod PI (parallel = ~0)
function paraDiff(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

// project point onto segment's param t in [0,1] domain (unclamped)
function proj(s, px, py) {
  return ((px - s.x1) * s.dx + (py - s.y1) * s.dy) / (s.len * s.len);
}
function perpDist(s, px, py) {
  return Math.abs((py - s.y1) * s.dx - (px - s.x1) * s.dy) / s.len;
}

/**
 * Collapse parallel double-line pairs into centerlines.
 * thickness window in cm; angleTol radians; minOverlap fraction.
 */
function collapse(segs, opt) {
  const used = new Array(segs.length).fill(false);
  const out = [];
  let pairs = 0;

  // sort longest-first so we anchor on dominant wall faces
  const order = segs.map((s, i) => i).sort((a, b) => segs[b].len - segs[a].len);

  for (const i of order) {
    if (used[i]) continue;
    const A = segs[i];
    let best = -1, bestScore = Infinity;
    for (const j of order) {
      if (j === i || used[j]) continue;
      const B = segs[j];
      if (paraDiff(A.ang, B.ang) > opt.angleTol) continue;
      // perpendicular distance from B's midpoint to A's line
      const mx = (B.x1 + B.x2) / 2, my = (B.y1 + B.y2) / 2;
      const d = perpDist(A, mx, my);
      if (d < opt.thickMin || d > opt.thickMax) continue;
      // overlap along A's direction
      const t1 = proj(A, B.x1, B.y1), t2 = proj(A, B.x2, B.y2);
      const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(1, Math.max(t1, t2));
      const ov = (hi - lo);
      if (ov < opt.minOverlap) continue;
      const score = d + (1 - ov) * 50; // prefer close + well-overlapping
      if (score < bestScore) { bestScore = score; best = j; }
    }
    if (best >= 0) {
      used[i] = used[best] = true;
      pairs++;
      out.push(centerline(A, segs[best]));
    } else {
      used[i] = true;
      out.push({ x1: A.x1, y1: A.y1, x2: A.x2, y2: A.y2, single: true });
    }
  }
  return { walls: out, pairs };
}

// centerline over the overlapping span of A and its partner B
function centerline(A, B) {
  // endpoints of B projected onto A
  const tB1 = proj(A, B.x1, B.y1), tB2 = proj(A, B.x2, B.y2);
  const lo = Math.max(0, Math.min(tB1, tB2));
  const hi = Math.min(1, Math.max(tB1, tB2));
  // points on A at lo/hi
  const ax1 = A.x1 + A.dx * lo, ay1 = A.y1 + A.dy * lo;
  const ax2 = A.x1 + A.dx * hi, ay2 = A.y1 + A.dy * hi;
  // corresponding closest points on B (offset by half thickness): approximate by
  // averaging A-points with B's line via projecting back
  const bMidPerp = (p) => {
    // foot of perpendicular from point p onto B
    const t = proj(B, p[0], p[1]);
    return [B.x1 + B.dx * t, B.y1 + B.dy * t];
  };
  const b1 = bMidPerp([ax1, ay1]); const b2 = bMidPerp([ax2, ay2]);
  return {
    x1: (ax1 + b1[0]) / 2, y1: (ay1 + b1[1]) / 2,
    x2: (ax2 + b2[0]) / 2, y2: (ay2 + b2[1]) / 2
  };
}

// snap endpoints to a grid (cm) and dedupe corners
function snapAndCount(walls, grid) {
  const key = (x, y) => `${Math.round(x / grid)},${Math.round(y / grid)}`;
  const corners = new Set();
  let kept = 0;
  walls.forEach(w => {
    const k1 = key(w.x1, w.y1), k2 = key(w.x2, w.y2);
    if (k1 === k2) return;
    corners.add(k1); corners.add(k2); kept++;
  });
  return { corners: corners.size, walls: kept };
}

// Merge collinear, overlapping/adjacent fragments into single long segments.
// Groups segments that lie on (nearly) the same infinite line and unions their
// extent along that line if the gap between them is small.
function mergeCollinear(segs, opt) {
  const used = new Array(segs.length).fill(false);
  const out = [];
  const order = segs.map((s, i) => i).sort((a, b) => segs[b].len - segs[a].len);
  for (const i of order) {
    if (used[i]) continue;
    const A = segs[i];
    // gather collinear members projected onto A
    let members = [{ t1: 0, t2: A.len }]; // in A-length units
    used[i] = true;
    for (const j of order) {
      if (used[j]) continue;
      const B = segs[j];
      if (paraDiff(A.ang, B.ang) > opt.angleTol) continue;
      const mx = (B.x1 + B.x2) / 2, my = (B.y1 + B.y2) / 2;
      if (perpDist(A, mx, my) > opt.collinearDist) continue;
      // also endpoints close to A's line
      if (perpDist(A, B.x1, B.y1) > opt.collinearDist) continue;
      if (perpDist(A, B.x2, B.y2) > opt.collinearDist) continue;
      const t1 = proj(A, B.x1, B.y1) * A.len, t2 = proj(A, B.x2, B.y2) * A.len;
      members.push({ t1: Math.min(t1, t2), t2: Math.max(t1, t2) });
      used[j] = true;
    }
    // union members along A with gap tolerance
    members.sort((a, b) => a.t1 - b.t1);
    let cur = { t1: members[0].t1, t2: members[0].t2 };
    const spans = [];
    for (let k = 1; k < members.length; k++) {
      if (members[k].t1 <= cur.t2 + opt.gap) {
        cur.t2 = Math.max(cur.t2, members[k].t2);
      } else { spans.push(cur); cur = { t1: members[k].t1, t2: members[k].t2 }; }
    }
    spans.push(cur);
    const ux = A.dx / A.len, uy = A.dy / A.len;
    spans.forEach(sp => {
      out.push(mk(
        { x: A.x1 + ux * sp.t1, y: A.y1 + uy * sp.t1 },
        { x: A.x1 + ux * sp.t2, y: A.y1 + uy * sp.t2 },
        1));
    });
  }
  return out;
}

async function main() {
  const file = process.argv[2];
  const layerRe = new RegExp(process.argv[3] || 'WALL', 'i');
  const db = await loadEntities(file);
  const scale = INCH_TO_CM; // INSUNITS=1
  let segs = segmentsFromEntities(db.entities, layerRe, scale);
  console.log('wall-layer segments (cm):', segs.length);

  segs = mergeCollinear(segs, { angleTol: 3 * Math.PI / 180, collinearDist: 2, gap: 15 });
  console.log('after collinear merge:', segs.length);

  const opt = { angleTol: 5 * Math.PI / 180, thickMin: 5, thickMax: 60, minOverlap: 0.3 };
  const { walls, pairs } = collapse(segs, opt);
  const singles = walls.filter(w => w.single).length;
  console.log(`collapsed: ${pairs} pairs merged, ${singles} singles kept -> ${walls.length} centerlines`);

  for (const g of [5, 10, 20]) {
    const r = snapAndCount(walls, g);
    console.log(`  snap grid ${g}cm -> corners=${r.corners} walls=${r.walls}`);
  }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
