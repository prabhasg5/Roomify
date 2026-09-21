# 3d_room — Roomify 3D designer

Blueprint3D fork: 2D floorplanner + Three.js 3D sharing one model, plus CAD import and AR export.

```bash
npm install
cd ../backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt && cd -
npm run dev      # tsc --watch + API (:9000) + FastAPI (:8080 + AR on https :8002) + Vite (:5173)
```

Serve over HTTP, not `file://` — the DWG WASM loader needs it.

| Command | What it does |
|---|---|
| `npm run dev` | The one you want. All five processes wired together. |
| `npm run build` | One-shot build → `example/js/blueprint3d.js` (gitignored). |
| `npm run backend` | FastAPI alone on :8080 — catalogue, designs, and the AR pages over plain HTTP. |
| `npm run ar` | The same app over HTTPS on :8002 with `ar_view/`'s cert. This is the one the phone talks to; WebXR needs TLS, and uvicorn does one protocol per process. |
| `npm start` | Express alone on :9000. No live reload, **and no proxy to :8080**, so the catalogue falls back to the static file and both AR design saving and the QR code's network lookup no-op. Use `npm run dev`. |
| `npm run check:models` · `check:catalogue` | Regression guards — see the docs below. |

`example/js/*.js` (cad-importer, dwg-importer, example, items…) is plain JS served as-is —
no build step. Only `src/*.ts` changes need one.

Python checks live in `backend/`: `venv/bin/python test_catalogue.py`, `test_designs.py`.

## Docs

Start at [PROJECT_OVERVIEW](../PROJECT_OVERVIEW.md) — it has the map and the current status.

## Style, for `src/*.ts`

Google JavaScript style. The parts that actually come up:

- two spaces, not tabs
- lowercase filenames, camelcase types, underscores where the type name has capitals:
  `HalfEdge` → `half_edge.ts`
- `/// <reference>` order: external, then other directories alphabetically, then the current
  directory alphabetically — sometimes bent to avoid bootstrap issues. Blank line after them.
- paths in references are **case-sensitive** on Linux/CI even though macOS forgives them
