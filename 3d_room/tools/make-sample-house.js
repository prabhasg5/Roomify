/**
 * make-sample-house.js — generate a small residential floor plan as a DXF with
 * DOUBLE-LINE walls on layer A-WALL (like real architectural CAD), so we can
 * validate the import pipeline (double-line collapse + room detection +
 * measurements + 3D) on a clean, simple case.
 *
 * Usage: node tools/make-sample-house.js > sample-plans/house.dxf
 * Units: feet (INSUNITS=2). Wall thickness 0.5 ft (6").
 */

const T = 0.5;       // wall thickness (ft)
const H = T / 2;     // half thickness

// Wall centerlines (ft). A ~40x30 ft house: perimeter + interior partitions.
const centerlines = [
  // perimeter
  [0, 0, 40, 0],
  [40, 0, 40, 30],
  [40, 30, 0, 30],
  [0, 30, 0, 0],
  // interior
  [24, 0, 24, 30],   // main vertical divider
  [0, 15, 24, 15],   // splits left half into two rooms
  [24, 18, 40, 18],  // splits right half
  [32, 18, 32, 30],  // bedroom partition (upper right)
];

// Offset a centerline segment by ±H perpendicular → two wall faces.
function faces(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len * H, ny = dx / len * H; // unit normal × half-thickness
  // extend each face by H at both ends so corners overlap (like mitred CAD)
  const ex = dx / len * H, ey = dy / len * H;
  return [
    [x1 + nx - ex, y1 + ny - ey, x2 + nx + ex, y2 + ny + ey],
    [x1 - nx - ex, y1 - ny - ey, x2 - nx + ex, y2 - ny + ey],
  ];
}

let out = [];
function line(x1, y1, x2, y2) {
  out.push('0', 'LINE', '8', 'A-WALL',
    '10', x1.toFixed(4), '20', y1.toFixed(4),
    '11', x2.toFixed(4), '21', y2.toFixed(4));
}

// HEADER with units = feet
let dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '2', '0', 'ENDSEC'];
dxf.push('0', 'SECTION', '2', 'ENTITIES');

centerlines.forEach(c => {
  faces(c[0], c[1], c[2], c[3]).forEach(f => line(f[0], f[1], f[2], f[3]));
});

dxf = dxf.concat(out);
dxf.push('0', 'ENDSEC', '0', 'EOF');

process.stdout.write(dxf.join('\n') + '\n');
