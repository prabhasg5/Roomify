/**
 * CAD Importer - Converts DXF/CAD files to Blueprint3D floorplan format
 * 
 * Parses DXF entities (LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE) and converts
 * them into the corners + walls JSON format that Blueprint3D expects.
 */

var CADImporter = (function() {

  // Tolerance for merging nearby endpoints into a single corner (in output units)
  var MERGE_TOLERANCE = 5; // cm

  // Default wall texture
  var DEFAULT_WALL_TEXTURE = {
    url: "rooms/textures/wallmap.png",
    stretch: true,
    scale: 0
  };

  // Number of line segments to approximate an arc
  var ARC_SEGMENTS = 16;

  /**
   * Generate a UUID compatible with BP3D.Core.Utils.guid()
   */
  function guid() {
    function s4() {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16).substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
  }

  /**
   * Unit conversion multipliers to centimeters
   */
  var UNIT_SCALES = {
    'mm': 0.1,          // millimeters → cm
    'cm': 1,            // centimeters → cm (identity)
    'm': 100,           // meters → cm
    'in': 2.54,         // inches → cm
    'ft': 30.48,        // feet → cm
    'auto': 1           // will be auto-detected
  };

  /**
   * Map an AutoCAD $INSUNITS / DWG INSUNITS code to one of our unit keys.
   * Returns null when the code is unitless/unknown so the caller can keep the
   * user-selected default. Codes are shared between DXF and DWG.
   * (1=in, 2=ft, 4=mm, 5=cm, 6=m)
   *
   * @param {number} code - INSUNITS header value
   * @returns {string|null} one of 'mm','cm','m','in','ft' or null
   */
  function unitFromInsunits(code) {
    switch (code) {
      case 1: return 'in';
      case 2: return 'ft';
      case 4: return 'mm';
      case 5: return 'cm';
      case 6: return 'm';
      default: return null; // 0 = unitless, or unsupported (miles, km, ...)
    }
  }

  /**
   * Parse a DXF file string into a normalized { entities, header } object.
   * Throws if the file cannot be parsed or has no entities.
   *
   * @param {string} dxfContent - Raw DXF file text
   * @returns {{entities: Array, header: object}}
   */
  function parseDxf(dxfContent) {
    var parser = new DxfParser();
    var dxf;
    try {
      dxf = parser.parseSync(dxfContent);
    } catch (e) {
      throw new Error('Failed to parse DXF file: ' + e.message);
    }

    if (!dxf || !dxf.entities || dxf.entities.length === 0) {
      throw new Error('DXF file contains no entities. Please check the file.');
    }

    return { entities: dxf.entities, header: dxf.header || {} };
  }

  /**
   * Detect the source unit from a parsed header (DXF or DWG).
   * DXF exposes it as header['$INSUNITS']; the DWG adapter exposes header.INSUNITS.
   *
   * @param {object} header - parsed header object
   * @returns {string|null} detected unit key, or null if undetermined
   */
  function detectUnit(header) {
    if (!header) return null;
    var code = header.INSUNITS;
    if (code == null) code = header['$INSUNITS'];
    if (code == null) return null;
    return unitFromInsunits(code);
  }

  /**
   * Parse a DXF file string and return a Blueprint3D-compatible JSON object.
   *
   * @param {string} dxfContent - Raw DXF file text
   * @param {string} sourceUnit - Unit of the DXF file ('mm', 'cm', 'm', 'in', 'ft')
   * @param {string} layerFilter - Comma-separated layer names to include (empty = all)
   * @returns {object} Blueprint3D serialization format
   */
  function dxfToBlueprint(dxfContent, sourceUnit, layerFilter) {
    var parsed = parseDxf(dxfContent);
    return entitiesToBlueprint(parsed.entities, sourceUnit, layerFilter);
  }

  /**
   * Convert an array of already-parsed CAD entities (dxf-parser shape) into a
   * Blueprint3D-compatible JSON object. This is the shared conversion core used
   * by both the DXF path (parseDxf) and the DWG path (DWGImporter normalizes its
   * entities to this same shape).
   *
   * @param {Array} entities - dxf-parser style entity array
   * @param {string} sourceUnit - 'mm','cm','m','in','ft'
   * @param {string} layerFilter - Comma-separated layer names to include (empty = all)
   * @returns {object} Blueprint3D serialization format
   */
  function entitiesToBlueprint(entities, sourceUnit, layerFilter, options) {
    if (!entities || entities.length === 0) {
      throw new Error('No CAD entities to import. Please check the file.');
    }

    options = options || {};
    var unitScale = UNIT_SCALES[sourceUnit] || 1;

    // Parse layer filter
    var allowedLayers = null;
    if (layerFilter && layerFilter.trim() !== '') {
      allowedLayers = {};
      layerFilter.split(',').forEach(function(layer) {
        allowedLayers[layer.trim().toUpperCase()] = true;
      });
    }

    // 1. Extract line segments from entities
    var segments = extractSegments(entities, unitScale, allowedLayers);

    if (segments.length === 0) {
      throw new Error('No wall segments found. Try changing the layer filter or unit settings.');
    }

    // 2. Optional architectural-plan cleanup: merge collinear fragments and
    //    collapse parallel double-line walls into single centerlines.
    if (options.collapseWalls) {
      segments = cleanupWallSegments(segments);
      if (segments.length === 0) {
        throw new Error('Wall cleanup removed all segments. Try disabling double-line collapse.');
      }
    }

    // 3. Deduplicate corners and build walls
    var result = buildCornersAndWalls(segments);

    // 4. Center the floorplan around origin
    centerFloorplan(result.corners);

    // 5. Build the Blueprint3D JSON
    return buildBlueprintJSON(result.corners, result.walls);
  }

  /**
   * Extract line segments from DXF entities.
   */
  function extractSegments(entities, unitScale, allowedLayers) {
    var segments = [];

    entities.forEach(function(entity) {
      // Filter by layer if specified
      if (allowedLayers && entity.layer) {
        if (!allowedLayers[entity.layer.toUpperCase()]) {
          return; // skip this entity
        }
      }

      switch (entity.type) {
        case 'LINE':
          extractLineSegments(entity, unitScale, segments);
          break;
        case 'LWPOLYLINE':
          extractLWPolylineSegments(entity, unitScale, segments);
          break;
        case 'POLYLINE':
          extractPolylineSegments(entity, unitScale, segments);
          break;
        case 'ARC':
          extractArcSegments(entity, unitScale, segments);
          break;
        case 'CIRCLE':
          extractCircleSegments(entity, unitScale, segments);
          break;
        // TEXT, DIMENSION, MTEXT, POINT, etc. are skipped
      }
    });

    return segments;
  }

  /**
   * Extract segments from a LINE entity.
   */
  function extractLineSegments(entity, scale, segments) {
    if (entity.vertices && entity.vertices.length >= 2) {
      segments.push({
        x1: entity.vertices[0].x * scale,
        y1: entity.vertices[0].y * scale,
        x2: entity.vertices[1].x * scale,
        y2: entity.vertices[1].y * scale
      });
    }
  }

  /**
   * Extract segments from LWPOLYLINE entity.
   */
  function extractLWPolylineSegments(entity, scale, segments) {
    if (!entity.vertices || entity.vertices.length < 2) return;

    for (var i = 0; i < entity.vertices.length - 1; i++) {
      var v1 = entity.vertices[i];
      var v2 = entity.vertices[i + 1];

      if (v1.bulge && v1.bulge !== 0) {
        // Bulge indicates an arc between these two vertices
        var arcSegs = bulgeToSegments(v1, v2, v1.bulge, scale);
        arcSegs.forEach(function(s) { segments.push(s); });
      } else {
        segments.push({
          x1: v1.x * scale,
          y1: v1.y * scale,
          x2: v2.x * scale,
          y2: v2.y * scale
        });
      }
    }

    // Close the polyline if shape flag is set
    if (entity.shape) {
      var last = entity.vertices[entity.vertices.length - 1];
      var first = entity.vertices[0];
      
      if (last.bulge && last.bulge !== 0) {
        var arcSegs = bulgeToSegments(last, first, last.bulge, scale);
        arcSegs.forEach(function(s) { segments.push(s); });
      } else {
        segments.push({
          x1: last.x * scale,
          y1: last.y * scale,
          x2: first.x * scale,
          y2: first.y * scale
        });
      }
    }
  }

  /**
   * Extract segments from POLYLINE entity.
   */
  function extractPolylineSegments(entity, scale, segments) {
    if (!entity.vertices || entity.vertices.length < 2) return;

    for (var i = 0; i < entity.vertices.length - 1; i++) {
      var v1 = entity.vertices[i];
      var v2 = entity.vertices[i + 1];

      if (v1.bulge && v1.bulge !== 0) {
        var arcSegs = bulgeToSegments(
          { x: v1.x, y: v1.y },
          { x: v2.x, y: v2.y },
          v1.bulge, scale
        );
        arcSegs.forEach(function(s) { segments.push(s); });
      } else {
        segments.push({
          x1: v1.x * scale,
          y1: v1.y * scale,
          x2: v2.x * scale,
          y2: v2.y * scale
        });
      }
    }

    // Close if shape flag
    if (entity.shape) {
      var last = entity.vertices[entity.vertices.length - 1];
      var first = entity.vertices[0];
      segments.push({
        x1: last.x * scale,
        y1: last.y * scale,
        x2: first.x * scale,
        y2: first.y * scale
      });
    }
  }

  /**
   * Extract segments from ARC entity (approximated as line segments).
   */
  function extractArcSegments(entity, scale, segments) {
    if (!entity.center || !entity.radius) return;

    var cx = entity.center.x * scale;
    var cy = entity.center.y * scale;
    var r = entity.radius * scale;
    var startAngle = entity.startAngle || 0;
    var endAngle = entity.endAngle || (2 * Math.PI);

    // Ensure endAngle > startAngle
    if (endAngle < startAngle) {
      endAngle += 2 * Math.PI;
    }

    var angleStep = (endAngle - startAngle) / ARC_SEGMENTS;

    for (var i = 0; i < ARC_SEGMENTS; i++) {
      var a1 = startAngle + i * angleStep;
      var a2 = startAngle + (i + 1) * angleStep;
      segments.push({
        x1: cx + r * Math.cos(a1),
        y1: cy + r * Math.sin(a1),
        x2: cx + r * Math.cos(a2),
        y2: cy + r * Math.sin(a2)
      });
    }
  }

  /**
   * Extract segments from CIRCLE entity (approximated as polygon).
   */
  function extractCircleSegments(entity, scale, segments) {
    if (!entity.center || !entity.radius) return;

    var cx = entity.center.x * scale;
    var cy = entity.center.y * scale;
    var r = entity.radius * scale;
    var numSegments = ARC_SEGMENTS * 2; // More segments for a full circle
    var angleStep = (2 * Math.PI) / numSegments;

    for (var i = 0; i < numSegments; i++) {
      var a1 = i * angleStep;
      var a2 = (i + 1) * angleStep;
      segments.push({
        x1: cx + r * Math.cos(a1),
        y1: cy + r * Math.sin(a1),
        x2: cx + r * Math.cos(a2),
        y2: cy + r * Math.sin(a2)
      });
    }
  }

  /**
   * Convert a bulge value between two vertices into arc line segments.
   */
  function bulgeToSegments(v1, v2, bulge, scale) {
    var result = [];

    var dx = v2.x - v1.x;
    var dy = v2.y - v1.y;
    var chordLen = Math.sqrt(dx * dx + dy * dy);

    if (chordLen < 1e-10) return result;

    var sagitta = Math.abs(bulge) * chordLen / 2;
    var radius = (chordLen * chordLen / 4 + sagitta * sagitta) / (2 * sagitta);

    // Midpoint of chord
    var mx = (v1.x + v2.x) / 2;
    var my = (v1.y + v2.y) / 2;

    // Normal to chord
    var nx = -dy / chordLen;
    var ny = dx / chordLen;

    // Distance from midpoint to center
    var d = radius - sagitta;
    var sign = bulge > 0 ? 1 : -1;

    var cx = mx + sign * d * nx;
    var cy = my + sign * d * ny;

    // Angles
    var startAngle = Math.atan2(v1.y - cy, v1.x - cx);
    var endAngle = Math.atan2(v2.y - cy, v2.x - cx);

    if (bulge > 0) {
      if (endAngle < startAngle) endAngle += 2 * Math.PI;
    } else {
      if (startAngle < endAngle) startAngle += 2 * Math.PI;
    }

    var numSegs = Math.max(4, Math.round(ARC_SEGMENTS * Math.abs(endAngle - startAngle) / (2 * Math.PI)));
    var angleStep = (endAngle - startAngle) / numSegs;

    for (var i = 0; i < numSegs; i++) {
      var a1 = startAngle + i * angleStep;
      var a2 = startAngle + (i + 1) * angleStep;
      result.push({
        x1: (cx + radius * Math.cos(a1)) * scale,
        y1: (cy + radius * Math.sin(a1)) * scale,
        x2: (cx + radius * Math.cos(a2)) * scale,
        y2: (cy + radius * Math.sin(a2)) * scale
      });
    }

    return result;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Architectural-plan wall cleanup
  //
  // Real CAD plans draw walls as TWO parallel lines (the wall faces), and
  // break each face into many short collinear segments at doors/junctions.
  // These helpers (1) merge collinear fragments back into full faces, then
  // (2) collapse parallel face pairs into a single centerline. Units are cm.
  // ───────────────────────────────────────────────────────────────────────

  var WALL_CLEANUP = {
    angleTol: 4 * Math.PI / 180, // max angle diff to treat as parallel
    collinearDist: 2,            // cm: max perp distance to treat as collinear
    gap: 20,                     // cm: max gap to bridge when merging collinear
    thickMin: 4,                 // cm: min wall thickness for a double-line pair
    thickMax: 60,                // cm: max wall thickness for a double-line pair
    minOverlap: 0.3,             // fraction of face length that must overlap
    minSegment: 2,               // cm: drop sub-2cm noise segments
    snapDist: 25,                // cm: endpoint cluster + T-junction snap radius
    tSplit: true                 // split walls at T-junctions so interior walls connect
  };

  function segGeom(s) {
    var dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    return { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, dx: dx, dy: dy, len: len, ang: Math.atan2(dy, dx) };
  }

  // angle difference mod PI (0 == parallel)
  function paraDiff(a, b) {
    var d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
  }

  // projection parameter (0..1 across the segment) of (px,py) onto segment g
  function projParam(g, px, py) {
    return ((px - g.x1) * g.dx + (py - g.y1) * g.dy) / (g.len * g.len);
  }

  function perpDist(g, px, py) {
    return Math.abs((py - g.y1) * g.dx - (px - g.x1) * g.dy) / g.len;
  }

  /** Merge collinear, overlapping/adjacent fragments into single segments. */
  function mergeCollinear(segments, opt) {
    var segs = segments.map(segGeom).filter(function(s) { return s.len > opt.minSegment; });
    var used = new Array(segs.length).fill(false);
    var out = [];
    var order = segs.map(function(s, i) { return i; })
      .sort(function(a, b) { return segs[b].len - segs[a].len; });

    order.forEach(function(i) {
      if (used[i]) return;
      var A = segs[i];
      used[i] = true;
      var members = [{ t1: 0, t2: A.len }];
      order.forEach(function(j) {
        if (used[j]) return;
        var B = segs[j];
        if (paraDiff(A.ang, B.ang) > opt.angleTol) return;
        if (perpDist(A, B.x1, B.y1) > opt.collinearDist) return;
        if (perpDist(A, B.x2, B.y2) > opt.collinearDist) return;
        var t1 = projParam(A, B.x1, B.y1) * A.len;
        var t2 = projParam(A, B.x2, B.y2) * A.len;
        members.push({ t1: Math.min(t1, t2), t2: Math.max(t1, t2) });
        used[j] = true;
      });
      members.sort(function(a, b) { return a.t1 - b.t1; });
      var cur = { t1: members[0].t1, t2: members[0].t2 };
      var spans = [];
      for (var k = 1; k < members.length; k++) {
        if (members[k].t1 <= cur.t2 + opt.gap) {
          cur.t2 = Math.max(cur.t2, members[k].t2);
        } else { spans.push(cur); cur = { t1: members[k].t1, t2: members[k].t2 }; }
      }
      spans.push(cur);
      var ux = A.dx / A.len, uy = A.dy / A.len;
      spans.forEach(function(sp) {
        out.push({
          x1: A.x1 + ux * sp.t1, y1: A.y1 + uy * sp.t1,
          x2: A.x1 + ux * sp.t2, y2: A.y1 + uy * sp.t2
        });
      });
    });
    return out;
  }

  /** Collapse parallel double-line wall faces into centerlines. */
  function collapseDoubleLines(segments, opt) {
    var segs = segments.map(segGeom);
    var used = new Array(segs.length).fill(false);
    var out = [];
    var order = segs.map(function(s, i) { return i; })
      .sort(function(a, b) { return segs[b].len - segs[a].len; });

    order.forEach(function(i) {
      if (used[i]) return;
      var A = segs[i];
      var best = -1, bestScore = Infinity;
      order.forEach(function(j) {
        if (j === i || used[j]) return;
        var B = segs[j];
        if (paraDiff(A.ang, B.ang) > opt.angleTol) return;
        var mx = (B.x1 + B.x2) / 2, my = (B.y1 + B.y2) / 2;
        var d = perpDist(A, mx, my);
        if (d < opt.thickMin || d > opt.thickMax) return;
        var t1 = projParam(A, B.x1, B.y1), t2 = projParam(A, B.x2, B.y2);
        var lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(1, Math.max(t1, t2));
        var ov = hi - lo;
        if (ov < opt.minOverlap) return;
        var score = d + (1 - ov) * 50;
        if (score < bestScore) { bestScore = score; best = j; }
      });
      if (best >= 0) {
        used[i] = used[best] = true;
        out.push(buildCenterline(A, segs[best]));
      } else {
        used[i] = true;
        out.push({ x1: A.x1, y1: A.y1, x2: A.x2, y2: A.y2 });
      }
    });
    return out;
  }

  /** Centerline over the overlapping span of face A and its partner B. */
  function buildCenterline(A, B) {
    var tB1 = projParam(A, B.x1, B.y1), tB2 = projParam(A, B.x2, B.y2);
    var lo = Math.max(0, Math.min(tB1, tB2));
    var hi = Math.min(1, Math.max(tB1, tB2));
    var ax1 = A.x1 + A.dx * lo, ay1 = A.y1 + A.dy * lo;
    var ax2 = A.x1 + A.dx * hi, ay2 = A.y1 + A.dy * hi;
    function footOnB(px, py) {
      var t = projParam(B, px, py);
      return [B.x1 + B.dx * t, B.y1 + B.dy * t];
    }
    var b1 = footOnB(ax1, ay1), b2 = footOnB(ax2, ay2);
    return {
      x1: (ax1 + b1[0]) / 2, y1: (ay1 + b1[1]) / 2,
      x2: (ax2 + b2[0]) / 2, y2: (ay2 + b2[1]) / 2
    };
  }

  /**
   * Snap nearby endpoints together and split walls at T-junctions so the
   * centerline network actually connects (collapse leaves small gaps at
   * corners and T-intersections). Operates on {x1,y1,x2,y2} segments.
   */
  function snapAndConnect(walls, snapDist, doTSplit) {
    // 1. Collect endpoints and cluster ones within snapDist (grid bucket +
    //    neighbor check), snapping each cluster to its average position.
    var pts = [];
    walls.forEach(function(w) {
      pts.push({ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 });
    });

    var cell = snapDist;
    var buckets = {};
    function bkey(x, y) { return Math.round(x / cell) + ',' + Math.round(y / cell); }
    // representative point per cluster
    var reps = [];
    function findRep(x, y) {
      // search the 3x3 neighborhood of buckets
      var cx = Math.round(x / cell), cy = Math.round(y / cell);
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          var arr = buckets[(cx + dx) + ',' + (cy + dy)];
          if (!arr) continue;
          for (var i = 0; i < arr.length; i++) {
            var r = reps[arr[i]];
            if ((r.x - x) * (r.x - x) + (r.y - y) * (r.y - y) <= snapDist * snapDist) {
              return arr[i];
            }
          }
        }
      }
      return -1;
    }
    function snapPoint(x, y) {
      var idx = findRep(x, y);
      if (idx >= 0) {
        var r = reps[idx];
        // running average keeps the cluster centered
        r.x = (r.x * r.n + x) / (r.n + 1);
        r.y = (r.y * r.n + y) / (r.n + 1);
        r.n++;
        return idx;
      }
      idx = reps.length;
      reps.push({ x: x, y: y, n: 1 });
      var k = bkey(x, y);
      (buckets[k] || (buckets[k] = [])).push(idx);
      return idx;
    }

    var snapped = walls.map(function(w) {
      return { a: snapPoint(w.x1, w.y1), b: snapPoint(w.x2, w.y2) };
    });

    // 2. Build segments from snapped rep coordinates.
    var segs = [];
    snapped.forEach(function(s) {
      if (s.a === s.b) return; // zero length after snap
      segs.push({ x1: reps[s.a].x, y1: reps[s.a].y, x2: reps[s.b].x, y2: reps[s.b].y });
    });

    // 3. T-junction split (optional): where a rep point lies on the interior of
    //    a segment (within snapDist), split that segment there so a shared
    //    corner forms. Disabled by default — it fragments long walls.
    if (!doTSplit) return segs;
    var out = [];
    segs.forEach(function(seg) {
      var g = segGeom(seg);
      var cuts = [];
      reps.forEach(function(r) {
        var t = projParam(g, r.x, r.y);
        if (t <= 0.001 || t >= 0.999) return;          // not interior
        if (perpDist(g, r.x, r.y) > snapDist) return;   // not on the wall
        cuts.push(t);
      });
      if (cuts.length === 0) { out.push(seg); return; }
      cuts.sort(function(a, b) { return a - b; });
      var prev = 0;
      cuts.concat([1]).forEach(function(t) {
        var x1 = g.x1 + g.dx * prev, y1 = g.y1 + g.dy * prev;
        var x2 = g.x1 + g.dx * t, y2 = g.y1 + g.dy * t;
        if (Math.abs(x2 - x1) > 0.5 || Math.abs(y2 - y1) > 0.5) {
          out.push({ x1: x1, y1: y1, x2: x2, y2: y2 });
        }
        prev = t;
      });
    });
    return out;
  }

  /**
   * Full wall cleanup pipeline: collinear merge → double-line collapse →
   * snap & connect (so walls share corners at junctions).
   */
  function cleanupWallSegments(segments) {
    var merged = mergeCollinear(segments, WALL_CLEANUP);
    var centerlines = collapseDoubleLines(merged, WALL_CLEANUP);
    return snapAndConnect(centerlines, WALL_CLEANUP.snapDist, WALL_CLEANUP.tSplit);
  }

  /**
   * Detect likely wall layer names from an entity array. Returns layer names
   * containing "WALL" (case-insensitive); used to pre-fill the layer filter.
   *
   * @param {Array} entities
   * @returns {string[]}
   */
  function detectWallLayers(entities) {
    if (!entities) return [];
    var seen = {};
    entities.forEach(function(e) {
      var L = e.layer || '';
      if (/wall/i.test(L)) seen[L] = true;
    });
    return Object.keys(seen);
  }

  /**
   * Deduplicate corners from segments and build wall list.
   */
  function buildCornersAndWalls(segments) {
    var corners = [];
    var walls = [];

    function findOrCreateCorner(x, y) {
      for (var i = 0; i < corners.length; i++) {
        var c = corners[i];
        var dist = Math.sqrt((c.x - x) * (c.x - x) + (c.y - y) * (c.y - y));
        if (dist < MERGE_TOLERANCE) {
          return c.id;
        }
      }
      var id = guid();
      corners.push({ id: id, x: x, y: y });
      return id;
    }

    // Track existing walls to avoid duplicates
    var wallSet = {};

    segments.forEach(function(seg) {
      var c1 = findOrCreateCorner(seg.x1, seg.y1);
      var c2 = findOrCreateCorner(seg.x2, seg.y2);

      if (c1 === c2) return; // skip zero-length walls

      // Create a canonical key to detect duplicates
      var key = c1 < c2 ? c1 + '|' + c2 : c2 + '|' + c1;
      if (wallSet[key]) return; // skip duplicate wall

      wallSet[key] = true;
      walls.push({ corner1: c1, corner2: c2 });
    });

    return { corners: corners, walls: walls };
  }

  /**
   * Center the floorplan around (0, 0).
   */
  function centerFloorplan(corners) {
    if (corners.length === 0) return;

    var minX = Infinity, maxX = -Infinity;
    var minY = Infinity, maxY = -Infinity;

    corners.forEach(function(c) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    });

    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;

    corners.forEach(function(c) {
      c.x -= cx;
      c.y -= cy;
    });
  }

  /**
   * Build the final Blueprint3D JSON from corners and walls.
   */
  function buildBlueprintJSON(corners, walls) {
    var cornerDict = {};
    corners.forEach(function(c) {
      cornerDict[c.id] = { x: c.x, y: c.y };
    });

    var wallArray = walls.map(function(w) {
      return {
        corner1: w.corner1,
        corner2: w.corner2,
        frontTexture: {
          url: DEFAULT_WALL_TEXTURE.url,
          stretch: DEFAULT_WALL_TEXTURE.stretch,
          scale: DEFAULT_WALL_TEXTURE.scale
        },
        backTexture: {
          url: DEFAULT_WALL_TEXTURE.url,
          stretch: DEFAULT_WALL_TEXTURE.stretch,
          scale: DEFAULT_WALL_TEXTURE.scale
        }
      };
    });

    return {
      floorplan: {
        corners: cornerDict,
        walls: wallArray,
        wallTextures: [],
        floorTextures: {},
        newFloorTextures: {}
      },
      items: []
    };
  }

  /**
   * Get layer information from an entity array for preview.
   */
  function getEntitiesLayers(entities) {
    if (!entities) return [];

    var layerCounts = {};
    var layerEntityTypes = {};

    entities.forEach(function(entity) {
      var layer = entity.layer || '0';
      layerCounts[layer] = (layerCounts[layer] || 0) + 1;
      
      if (!layerEntityTypes[layer]) {
        layerEntityTypes[layer] = {};
      }
      layerEntityTypes[layer][entity.type] = true;
    });

    var layers = [];
    for (var name in layerCounts) {
      layers.push({
        name: name,
        entityCount: layerCounts[name],
        entityTypes: Object.keys(layerEntityTypes[name]).join(', ')
      });
    }

    // Sort by entity count descending
    layers.sort(function(a, b) { return b.entityCount - a.entityCount; });

    return layers;
  }

  /**
   * Get summary statistics from an entity array.
   */
  function getEntitiesSummary(entities) {
    if (!entities) {
      return { totalEntities: 0, layers: [], entityTypes: {} };
    }

    var entityTypes = {};
    entities.forEach(function(entity) {
      entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
    });

    return {
      totalEntities: entities.length,
      layers: getEntitiesLayers(entities),
      entityTypes: entityTypes
    };
  }

  /**
   * Get layer information from a DXF file string (back-compat wrapper).
   */
  function getDxfLayers(dxfContent) {
    return getEntitiesLayers(parseDxf(dxfContent).entities);
  }

  /**
   * Get summary statistics about a DXF file string (back-compat wrapper).
   */
  function getDxfSummary(dxfContent) {
    return getEntitiesSummary(parseDxf(dxfContent).entities);
  }

  // Public API
  return {
    // entity-based core (shared by DXF + DWG)
    entitiesToBlueprint: entitiesToBlueprint,
    getEntitiesSummary: getEntitiesSummary,
    getEntitiesLayers: getEntitiesLayers,
    parseDxf: parseDxf,
    detectUnit: detectUnit,
    detectWallLayers: detectWallLayers,
    // DXF string convenience wrappers
    dxfToBlueprint: dxfToBlueprint,
    getDxfLayers: getDxfLayers,
    getDxfSummary: getDxfSummary,
    UNIT_SCALES: UNIT_SCALES
  };

})();
