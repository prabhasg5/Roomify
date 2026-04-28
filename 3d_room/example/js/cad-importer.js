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
   * Parse a DXF file string and return a Blueprint3D-compatible JSON object.
   * 
   * @param {string} dxfContent - Raw DXF file text
   * @param {string} sourceUnit - Unit of the DXF file ('mm', 'cm', 'm', 'in', 'ft')
   * @param {string} layerFilter - Comma-separated layer names to include (empty = all)
   * @returns {object} Blueprint3D serialization format
   */
  function dxfToBlueprint(dxfContent, sourceUnit, layerFilter) {
    // 1. Parse the DXF file
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

    var unitScale = UNIT_SCALES[sourceUnit] || 1;

    // Parse layer filter
    var allowedLayers = null;
    if (layerFilter && layerFilter.trim() !== '') {
      allowedLayers = {};
      layerFilter.split(',').forEach(function(layer) {
        allowedLayers[layer.trim().toUpperCase()] = true;
      });
    }

    // 2. Extract line segments from DXF entities
    var segments = extractSegments(dxf.entities, unitScale, allowedLayers);

    if (segments.length === 0) {
      throw new Error('No wall segments found in the DXF file. Try changing the layer filter or unit settings.');
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
   * Get layer information from a DXF file for preview.
   */
  function getDxfLayers(dxfContent) {
    var parser = new DxfParser();
    var dxf = parser.parseSync(dxfContent);
    
    if (!dxf || !dxf.entities) return [];

    var layerCounts = {};
    var layerEntityTypes = {};

    dxf.entities.forEach(function(entity) {
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
   * Get summary statistics about a DXF file.
   */
  function getDxfSummary(dxfContent) {
    var parser = new DxfParser();
    var dxf = parser.parseSync(dxfContent);
    
    if (!dxf || !dxf.entities) {
      return { totalEntities: 0, layers: [], entityTypes: {} };
    }

    var entityTypes = {};
    dxf.entities.forEach(function(entity) {
      entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
    });

    return {
      totalEntities: dxf.entities.length,
      layers: getDxfLayers(dxfContent),
      entityTypes: entityTypes
    };
  }

  // Public API
  return {
    dxfToBlueprint: dxfToBlueprint,
    getDxfLayers: getDxfLayers,
    getDxfSummary: getDxfSummary,
    UNIT_SCALES: UNIT_SCALES
  };

})();
