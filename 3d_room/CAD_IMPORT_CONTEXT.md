# CAD Import → 2D Floorplan (with measurements) → 3D — Working Context

## ▶ RUNBOOK / COMMANDS (quick reference)

All commands run from the `3d_room/` directory:
```bash
cd /Users/jayanandaprabhasmekala/Roomify/3d_room
```

**One-time setup (only if node_modules is missing):**
```bash
npm install
```

**Start the app server** (serves example/ on http://localhost:9000 — REQUIRED for DWG,
because the WASM can't load over file://):
```bash
node model-server.js
# then open http://localhost:9000/  (hard-refresh with Cmd+Shift+R after rebuilds)
```

**Stop the server:**
```bash
pkill -f "node model-server.js"
```
(or just press Ctrl+C in the terminal running it)

**Rebuild after editing any TypeScript in src/** (grunt-cli's .bin shim lacks exec bit, so
call via node). Outputs example/js/blueprint3d.js (gitignored):
```bash
node node_modules/grunt/bin/grunt default
```
NOTE: editing files in example/js/ (cad-importer.js, dwg-importer.js, example.js) needs NO
rebuild — they're plain JS served as-is. Only src/*.ts changes need grunt.

**Generate the sample residential test plan** (→ example/sample-plans/house.dxf):
```bash
node tools/make-sample-house.js > example/sample-plans/house.dxf
```

**Inspect a real DWG/DXF (layers, entity types, units, bbox):**
```bash
node tools/analyze-dwg.js /path/to/plan.dwg
```

**Prototype/measure wall-extraction offline against a file:**
```bash
node tools/proto-walls.js /path/to/plan.dwg WALL
```

**Using the import in the browser:** Edit Floorplan → Import CAD → pick a .dxf/.dwg →
(units + wall layer auto-fill; "Collapse double-line walls" on) → Import Floorplan →
walls appear in 2D with measurements → Done » for 3D. Mouse-wheel zooms the 2D view.

---



> Purpose: persistent context so this feature can be continued in a fresh chat without
> re-deriving the codebase. Read this first.

## Goal (user's words)
Upload a CAD file → draw it as a **2D floor plan with measurements** → have those changes
**automatically reflect in 3D** (so furniture/AR can follow). Discuss first, then implement.

## Project at a glance
- Roomify 3D designer lives in [`3d_room/`](.). Built on **Blueprint3D** (2D floorplanner +
  Three.js 3D, sharing one data model).
- Core pipeline:
  `CAD/draw → floorplan JSON (corners + walls) → BP3D.Model.Model.loadSerialized() → 2D canvas AND 3D scene`
- 2D and 3D are **two views of one `Floorplan` model** — loading into the model renders both.
  No extra wiring needed to "push 2D to 3D".
- TS source in `src/`, compiled via **grunt** into `example/js/blueprint3d.js` (artifact is
  committed and present). Build: `cd 3d_room && npm install && grunt`.

## Key files
| Concern | File |
|---|---|
| DXF→Blueprint3D conversion | [`example/js/cad-importer.js`](example/js/cad-importer.js) |
| DXF parser (vendored, minified) | [`example/js/dxf-parser.js`](example/js/dxf-parser.js) |
| Import UI flow (modal, file read, execute) | [`example/js/example.js`](example/js/example.js) ~lines 748–903 |
| Import button + modal markup | [`example/index.html`](example/index.html#L301) (~301–388) |
| Model: load/export serialized, 2D↔3D bridge | [`src/model/model.ts`](src/model/model.ts) |
| Floorplan: corners/walls/rooms, save/loadFloorplan | [`src/model/floorplan.ts`](src/model/floorplan.ts) |
| 2D rendering + **wall length labels** | [`src/floorplanner/floorplanner_view.ts`](src/floorplanner/floorplanner_view.ts) (`drawEdgeLabel`, line ~147) |
| Units → display string | [`src/core/dimensioning.ts`](src/core/dimensioning.ts) (`cmToMeasure`) |
| DWG server (INTENDED, currently EMPTY) | [`dwg-server.js`](dwg-server.js) |

## What ALREADY works (verified by reading code)
1. **DXF import is fully wired end-to-end.** `cad-importer.js` parses LINE, LWPOLYLINE,
   POLYLINE, ARC, CIRCLE, and bulge arcs → merges near corners (tolerance 5cm) → dedupes
   walls → `loadSerialized()`. Modal supports unit selection (mm/cm/m/in/ft, default ft)
   and comma-separated layer filtering. Entity-type/layer summary shown before import.
2. **Measurements in 2D are automatic.** Every wall edge length is drawn via
   `drawEdgeLabel` using `Dimensioning.cmToMeasure` (labels skipped for walls < 60cm).
3. **2D→3D reflection is automatic** (inherent to Blueprint3D model).
4. Internal model unit is **centimeters**. `cad-importer.js UNIT_SCALES` converts to cm.

So: a clean `.dxf` of single-line walls already imports, shows measurements, and appears
in 3D today.

## Gaps / planned work
1. **`.dwg` support (biggest gap).** `.dwg` is binary AutoCAD — what most users have.
   `@mlightcad/libredwg-web` is in `package.json` but UNUSED; `dwg-server.js` is empty.
   Plan: convert DWG→DXF (libredwg, server endpoint OR client-side WASM), then reuse the
   existing DXF importer. UI already accepts only `.dxf` (`accept=".dxf"`) — widen to `.dwg`.
2. **Naive wall extraction.** Architectural plans draw walls as TWO parallel lines
   (thickness). Current code makes every line a wall → doubled/messy walls. Need
   double-line→centerline collapse + better layer filtering (drop furniture/dims/text/hatch).
3. **No unit auto-detect.** DXF `$INSUNITS` header (in `dxf.header`) could auto-select units
   instead of the manual dropdown.
4. **DIMENSION entities dropped.** Original annotated dimensions are skipped; wall lengths
   are recomputed (acceptable) but source dims not preserved.

## Tools / libraries
- `@mlightcad/libredwg-web` (installed) — DWG→DXF.
- `dxf-parser` (vendored) — keep as DXF entity parser.
- Existing Blueprint3D model — unchanged; just feed it cleaner data.
- Plain geometry helpers (no new heavy deps) for centerline merge + unit detection.

## End-result definition of done
Upload `.dwg` or `.dxf` → auto/selected units + wall-layer filter → entity summary preview →
Import → walls render in 2D **with length labels**, rooms auto-detected → "Done" shows the
same layout in 3D ready for furniture/AR.
Realistic caveat: arbitrary CAD quality varies; a layer-filter + manual-nudge step stays
part of the flow. Fully automatic perfect extraction is not a promise.

## DECISIONS (2026-06-19)
- **DWG conversion: client-side WASM** via `@mlightcad/libredwg-web` in the browser. No
  server dependency — must work by just opening `example/index.html`, same as DXF today.
  (`dwg-server.js` stays empty / not the chosen path.)
- **Priority: DWG support FIRST**, before wall-extraction polish.

## Implementation order (DWG-first per decision above)
1. Wire `@mlightcad/libredwg-web` into the page (vendored/bundled script in `example/js/`,
   loaded from `index.html` like dxf-parser.js). Confirm it runs purely client-side.
2. Widen UI: `cad-file-input accept=".dxf,.dwg"`; on `.dwg`, read as ArrayBuffer, convert
   DWG→DXF string via libredwg, then feed the EXISTING `CADImporter.dxfToBlueprint` path.
3. Add `$INSUNITS` auto-detect (pre-select unit dropdown, user can override).
4. Improve wall extraction: layer-aware filtering + double-line→centerline collapse.
5. (Optional) preserve/import DIMENSION annotations as non-editable labels.
6. Rebuild via grunt (only if TS touched); verify in `example/index.html`.

## Status log
- 2026-06-19: Context created. Discovery complete — DXF import + 2D measurements + 2D→3D
  already functional. No new code written yet (discussion phase per user request).
- 2026-06-19: Implemented DWG support (client-side WASM) + unit auto-detect. DONE so far:
  - Vendored libredwg into `example/js/vendor/libredwg/` (`libredwg-web.js` UMD +
    `libredwg-web.wasm`). Global is `window['libredwg-web']` (`LibreDwg`, `Dwg_File_Type`).
  - New `example/js/dwg-importer.js` (`DWGImporter`): lazy-loads the WASM engine, reads a
    .dwg ArrayBuffer via `LibreDwg.dwg_read_data` + `convert`, and `normalizeEntities()`
    maps libredwg entities (LINE startPoint/endPoint, LWPOLYLINE/POLYLINE flag&1=closed,
    ARC/CIRCLE, deg→rad guard) into the dxf-parser shape.
  - Refactored `example/js/cad-importer.js`: added `entitiesToBlueprint`, `parseDxf`,
    `getEntitiesSummary`, `getEntitiesLayers`, `detectUnit` (INSUNITS 1=in,2=ft,4=mm,5=cm,
    6=m). Old `dxfToBlueprint`/`getDxf*` kept as wrappers. Conversion core unchanged.
  - `example/index.html`: added libredwg + dwg-importer script tags; file input now
    `accept=".dxf,.dwg"`.
  - `example/js/example.js`: import flow now stores normalized `cadEntities`+`cadHeader`
    (not raw text); branches DXF (text) vs DWG (ArrayBuffer→async WASM); shared
    `showCADSummary()` renders summary/layers + pre-selects detected unit; import uses
    `entitiesToBlueprint`.
  - VERIFIED (Node, same WASM as browser): engine boots & resolves wasm; DWG synthetic
    room → 4 clean walls, WALL-layer filter works, INSUNITS=5→cm, wall length 400cm;
    DXF back-compat → 2 lines/3 corners, $INSUNITS=6→m. No grunt rebuild needed (only
    `example/js` touched, not TS).
  - NOT yet tested with a real binary .dwg file in a browser (deferred per user: "then we
    will decide how to test it"). file:// may block wasm fetch — serve via a local server
    (`npm start` / python) when testing.
- 2026-06-19 (cont.): Tested real plan `~/Downloads/building001-0_floor1.dwg` via
  `tools/analyze-dwg.js`. Findings: INSUNITS=1 (inches); 2268 entities; walls cleanly on
  layer **A-WALL** (1180 LINE + 10 LWPOLYLINE); doors/glazing/cols/grid/text on separate
  AIA layers. ~164ft × 193ft, ~70 rooms. Confirms real plans are double-line + many layers.
  User decision: build **BOTH** residential polish AND large-plan visualization mode.
- 2026-06-19 (cont.): Implemented wall-extraction + perf guard. DONE:
  - `cad-importer.js`: added `cleanupWallSegments` (mergeCollinear → collapseDoubleLines),
    `detectWallLayers`, and a `collapseWalls` option on `entitiesToBlueprint(...,options)`.
    Geometry helpers: segGeom/paraDiff/projParam/perpDist/buildCenterline. Tunables in
    `WALL_CLEANUP` (angleTol 4°, collinearDist 2cm, gap 20cm, thickMin/Max 4–60cm, etc.).
  - `index.html`: added "Collapse double-line walls" checkbox (`#cad-collapse-walls`,
    checked by default). `example.js`: `showCADSummary` auto-fills `#cad-layer-filter`
    with detected wall layers; `executeCADImport` passes `{collapseWalls}`.
  - VERIFIED offline on the real file: wall layer auto-detected = ['A-WALL']; A-WALL +
    collapse → 1151 walls → **627 walls / 1175 corners** (collinear+double-line collapse
    works). Residential (small) plans collapse to a handful of clean walls.
  - PERF GUARD (TS, rebuilt): `src/model/floorplan.ts` — added
    `maxCornersForRoomDetection = 150`; `update()` skips the expensive `findRooms`
    tightest-cycle search above that (walls still get edges via `assignOrphanEdges`, so
    2D measurements + 3D walls render, just no room floor polygons). Added `deferUpdate`
    flag + batched `loadFloorplan` so update()/findRooms runs ONCE after bulk wall add
    (was once-per-wall → would freeze). Rebuilt via `node node_modules/grunt/bin/grunt
    default` (grunt-cli 1.6.1 works; rebuild of committed sources is byte-identical, so
    toolchain is trustworthy). Guard confirmed present in `example/js/blueprint3d.js`.
    NOTE: build artifacts (blueprint3d.js, three.min.js, dist/) are gitignored.
  - HOW TO REBUILD TS: `cd 3d_room && node node_modules/grunt/bin/grunt default`
    (the `.bin/grunt` shim has no exec bit; call via node).
  - NOT yet tested in-browser with the real 627-wall plan (THREE/DOM needed). Expect a
    few seconds to build 627 wall meshes; should not freeze (no findRooms).
- 2026-06-19 (cont.): First in-browser test of building001-0_floor1.dwg SUCCEEDED — loaded
  without freezing, full building rendered in 3D, 2D showed walls + measurements. Perf guard
  confirmed working. Two issues found: (1) couldn't zoom to navigate the big plan, (2) walls
  fragmented/disconnected at junctions. Fixes implemented this round:
  - WALL CONNECTIVITY (`cad-importer.js`): added `snapAndConnect()` (endpoint clustering via
    bucket grid + T-junction split where a corner lies on a wall interior). Added
    `WALL_CLEANUP.snapDist = 25` (cm). Pipeline now mergeCollinear → collapseDoubleLines →
    snapAndConnect. Offline result on real file: 627 walls/1175 corners → **406 walls/508
    corners** (~48% still dangling, much of it real: stubs/columns/door jambs).
  - 3D ZOOM (`src/three/controls.ts`): `maxDistance` 1500 → **30000** cm (was capped at
    ~49ft; building is ~164ft, so couldn't pull back).
  - 2D ZOOM (`src/floorplanner/floorplanner.ts`): added mouse-wheel `wheel()` zoom about the
    cursor (clamps pixelsPerCm 0.02–5.0), and `fitView()` so `reset()` auto-fits the whole
    plan to the canvas on load (helps large AND small plans). pixelsPerCm/cmPerPixel now
    mutable at runtime.
  - Rebuilt (grunt default); all three verified present in served `example/js/blueprint3d.js`
    + `cad-importer.js`. Awaiting user re-test.
  - KNOWN COSMETIC BUG (pre-existing, not introduced): inch labels can read e.g. 6'12" — the
    `cmToMeasure` inch path rounds inches to 12 instead of rolling to the next foot
    (`src/core/dimensioning.ts`). Easy fix if desired.
- 2026-06-19 (cont.): 2nd in-browser test — 3D went BLACK and 2D walls fragmented. Diagnosed:
  - BLACK 3D ROOT CAUSE: `centerCamera()` (src/three/main.ts) sets camera distance =
    floorplan.size.z × 1.5 ≈ 8800cm for this building. Test 1 only rendered because the OLD
    `maxDistance=1500` CLAMPED the camera close. After raising maxDistance to 30000, the
    camera sits ~12,470cm away — beyond the camera FAR plane (was 10000) → everything
    clipped → black. FIX: camera far 10000 → **100000** (main.ts). Rebuilt.
  - Verified offline the importer geometry is clean: NO NaN, maxAbsCoord 96ft (half-extent,
    expected), only 5 sub-10cm walls. So black 3D was NOT bad data — purely the far-plane.
  - FRAGMENTATION: real cause is the collapse step leaving short centerline stubs + unpaired
    singles (≈114 walls <2ft of 305). Made T-junction split optional (`WALL_CLEANUP.tSplit`,
    default FALSE — it fragmented long walls without clear benefit). Endpoint clustering
    stays on. Variants measured: collapse+cluster = 305 walls/421 corners; +tSplit = 406/508.
    Neither is "clean" — robust wall extraction from arbitrary commercial CAD is genuinely
    hard (inherent limitation, not a quick fix).
  - 2D LABEL DECLUTTER (floorplanner_view.ts): drawEdgeLabel now skips labels whose ON-SCREEN
    length < 45px (was a fixed 60cm), so zoomed-out big plans aren't buried in overlapping
    labels; labels reappear when zoomed in.
  - STATE: 3D black FIXED (pending user re-test). Commercial-plan 2D is a navigable measured
    wall trace, not a clean room model. Decision pending from user on how much more to invest
    in extraction quality vs. focus on residential plans (Roomify's core use case).
- 2026-06-19 (cont.): User chose to validate on a RESIDENTIAL plan but had none. Generated a
  synthetic one: `tools/make-sample-house.js` → `example/sample-plans/house.dxf` — a ~40×30ft
  house, 8 walls drawn as DOUBLE lines on layer A-WALL, INSUNITS=2 (feet).
  - IMPORTANT FINDING: with `tSplit:false` the house imported with dangling=8 — interior
    walls meet others mid-span (T-junctions) and floated. So T-split is REQUIRED for
    connectivity in ANY real plan (residential too). Re-enabled `WALL_CLEANUP.tSplit = true`
    (default). Re-validated house: **15 corners / 16 walls / dangling=3** — mostly connected,
    should form detectable rooms (corners < 150 so room detection runs). The earlier
    commercial fragmentation is the inherent cost of T-split on a 70-room plan, accepted.
  - Served state now: camera far 100000 (3D black fixed), 2D label declutter, tSplit=true.
    Only cad-importer.js changed since last build (JS, no rebuild needed).
  - TODO: user to import house.dxf in browser and confirm clean rooms + measurements + 3D.
    Could also fetch a REAL residential DWG for a robustness test (synthetic is designed to
    work). NEXT polish: fix 6'12" inch rounding (dimensioning.ts); expose snapDist/tSplit as
    settings; optional DIMENSION import.
