/**
 * DWG Importer - Reads binary AutoCAD .dwg files fully client-side via the
 * libredwg WebAssembly build (@mlightcad/libredwg-web), then normalizes the
 * entities into the same shape dxf-parser produces so the existing CADImporter
 * pipeline (CADImporter.entitiesToBlueprint) can consume them unchanged.
 *
 * The vendored UMD bundle exposes a global `window['libredwg-web']` with
 * `LibreDwg` and `Dwg_File_Type`. The matching .wasm sits next to the bundle.
 */

var DWGImporter = (function () {

  // Folder (relative to the page) holding libredwg-web.js + libredwg-web.wasm.
  // LibreDwg.create(path) loads `${path}/libredwg-web.wasm`.
  var WASM_DIR = 'js/vendor/libredwg';

  // Cached LibreDwg instance (the wasm module is heavy; load once).
  var _libInstance = null;
  var _loadingPromise = null;

  /**
   * Resolve the libredwg UMD global, regardless of how it attached itself.
   */
  function getLib() {
    var g = (typeof window !== 'undefined') ? window : self;
    return g['libredwg-web'] || g.LibreDwgWeb || null;
  }

  /**
   * Whether the libredwg UMD bundle script has loaded on the page.
   */
  function isAvailable() {
    var lib = getLib();
    return !!(lib && lib.LibreDwg);
  }

  /**
   * Lazily create (and cache) the LibreDwg wasm instance.
   * @returns {Promise<object>} LibreDwg instance
   */
  function ensureLoaded() {
    if (_libInstance) return Promise.resolve(_libInstance);
    if (_loadingPromise) return _loadingPromise;

    var lib = getLib();
    if (!lib || !lib.LibreDwg) {
      return Promise.reject(new Error(
        'libredwg library not loaded. Make sure js/vendor/libredwg/libredwg-web.js ' +
        'is included before dwg-importer.js.'));
    }

    _loadingPromise = lib.LibreDwg.create(WASM_DIR).then(function (instance) {
      _libInstance = instance;
      _loadingPromise = null;
      return instance;
    }).catch(function (err) {
      _loadingPromise = null;
      throw new Error('Failed to initialize the DWG (WASM) engine: ' + err.message);
    });

    return _loadingPromise;
  }

  /**
   * Normalize an angle that may be in degrees into radians.
   * libredwg may report arc angles in degrees; anything well beyond 2π is
   * almost certainly degrees.
   */
  function toRadians(angle) {
    if (typeof angle !== 'number' || isNaN(angle)) return 0;
    return (Math.abs(angle) > 2 * Math.PI + 0.001) ? (angle * Math.PI / 180) : angle;
  }

  /**
   * Convert a libredwg DwgDatabase into a dxf-parser-style entity array
   * (LINE/LWPOLYLINE/POLYLINE/ARC/CIRCLE) that CADImporter understands.
   *
   * @param {object} db - DwgDatabase from LibreDwg.convert()
   * @returns {Array} normalized entity array
   */
  function normalizeEntities(db) {
    var out = [];
    var entities = (db && db.entities) || [];

    entities.forEach(function (e) {
      if (!e || !e.type) return;
      var layer = e.layer || '0';

      switch (e.type) {
        case 'LINE':
          if (e.startPoint && e.endPoint) {
            out.push({
              type: 'LINE',
              layer: layer,
              vertices: [
                { x: e.startPoint.x, y: e.startPoint.y },
                { x: e.endPoint.x, y: e.endPoint.y }
              ]
            });
          }
          break;

        case 'LWPOLYLINE':
          if (e.vertices && e.vertices.length >= 2) {
            out.push({
              type: 'LWPOLYLINE',
              layer: layer,
              shape: !!(e.flag & 1), // bit 1 = closed
              vertices: e.vertices.map(function (v) {
                return { x: v.x, y: v.y, bulge: v.bulge || 0 };
              })
            });
          }
          break;

        case 'POLYLINE2D':
        case 'POLYLINE':
          if (e.vertices && e.vertices.length >= 2) {
            out.push({
              type: 'POLYLINE',
              layer: layer,
              shape: !!(e.flag & 1), // bit 1 = closed
              vertices: e.vertices.map(function (v) {
                return { x: v.x, y: v.y, bulge: v.bulge || 0 };
              })
            });
          }
          break;

        case 'ARC':
          if (e.center && typeof e.radius === 'number') {
            out.push({
              type: 'ARC',
              layer: layer,
              center: { x: e.center.x, y: e.center.y },
              radius: e.radius,
              startAngle: toRadians(e.startAngle),
              endAngle: toRadians(e.endAngle)
            });
          }
          break;

        case 'CIRCLE':
          if (e.center && typeof e.radius === 'number') {
            out.push({
              type: 'CIRCLE',
              layer: layer,
              center: { x: e.center.x, y: e.center.y },
              radius: e.radius
            });
          }
          break;

        // TEXT, MTEXT, DIMENSION, INSERT, HATCH, etc. are skipped — same as
        // the DXF importer.
      }
    });

    return out;
  }

  /**
   * Parse a .dwg file (ArrayBuffer) into a normalized { entities, header }
   * object compatible with CADImporter.entitiesToBlueprint / getEntitiesSummary.
   *
   * @param {ArrayBuffer} arrayBuffer - raw .dwg file bytes
   * @returns {Promise<{entities: Array, header: object}>}
   */
  function parse(arrayBuffer) {
    return ensureLoaded().then(function (libredwg) {
      var lib = getLib();
      var fileType = (lib.Dwg_File_Type && lib.Dwg_File_Type.DWG != null)
        ? lib.Dwg_File_Type.DWG
        : 0; // 0 == DWG in libredwg's enum

      var dwg = libredwg.dwg_read_data(arrayBuffer, fileType);
      if (dwg == null) {
        throw new Error('Could not read the DWG file. It may be corrupt or an unsupported version.');
      }

      var db;
      try {
        db = libredwg.convert(dwg);
      } finally {
        // Free the native Dwg_Data regardless of conversion outcome.
        try { libredwg.dwg_free(dwg); } catch (e) { /* noop */ }
      }

      var entities = normalizeEntities(db);
      if (entities.length === 0) {
        throw new Error('No supported geometry (lines/polylines/arcs) found in the DWG file.');
      }

      var header = { INSUNITS: (db && db.header && db.header.INSUNITS) };
      return { entities: entities, header: header };
    });
  }

  // Public API
  return {
    isAvailable: isAvailable,
    ensureLoaded: ensureLoaded,
    parse: parse,
    normalizeEntities: normalizeEntities
  };

})();
