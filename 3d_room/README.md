# 3d_room — Roomify 3D designer

Blueprint3D fork: 2D floorplanner + Three.js 3D sharing one model, plus CAD import and AR export.

```bash
npm install
npm run dev      # tsc --watch + API (:9000) + Vite (:5173) → opens the app
```

Serve over HTTP, not `file://` — the DWG WASM loader needs it.

| Command | What it does |
|---|---|
| `npm run dev` | The one you want. Watch-compiles `src/*.ts`, runs the API, serves `example/`. |
| `npm run build` | One-shot build → `example/js/blueprint3d.js` (gitignored). |
| `npm start` | Express only, on :9000. No live reload. Fallback / prod-ish serving. |

`example/js/*.js` (cad-importer, dwg-importer, example, items…) is plain JS served as-is —
no build step. Only `src/*.ts` changes need one.

Docs: [PROJECT_OVERVIEW](../PROJECT_OVERVIEW.md) · [MODERNIZATION_CONTEXT](MODERNIZATION_CONTEXT.md) ·
[CAD_IMPORT_CONTEXT](CAD_IMPORT_CONTEXT.md) · [CATALOGUE_GUIDE](CATALOGUE_GUIDE.md) ·
[AGENT_ARCHITECTURE](AGENT_ARCHITECTURE.md) · [CODING_STYLE](CODING_STYLE.md)
