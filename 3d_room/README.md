# 3d_room — Roomify 3D designer

2D floorplanner (SVG) + 3D workspace (React + react-three-fiber) over one design, plus CAD
import, model upload, GLB export and AR handoff.

```bash
npm install
cd ../backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt && cd -
npm run dev      # Vite (:5173) + FastAPI (:8080, and AR on https :8002)
```

| Command | What it does |
|---|---|
| `npm run dev` | The one you want: Vite + both FastAPI processes, all of `/api` proxied to :8080. |
| `npm run build` | Production build → `dist/` (the page + the bundle). |
| `npm run preview` | Serves `dist/` on :4173, with the run-time assets from `example/`; needs FastAPI running. |
| `npm run backend` | FastAPI alone on :8080: catalogue, designs, uploads, and the AR pages over plain HTTP. |
| `npm run ar` | The same app over HTTPS on :8002 with `ar_view/`'s cert. This is the one the phone talks to; WebXR needs TLS, and uvicorn does one protocol per process. |
| `npm test` · `typecheck` · `check:catalogue` | Vitest (kernel goldens, CAD import, store), `tsc` on `app/`, catalogue ids + GLBs. |

`ar_legacy/` is AR-only (parked): the r69 `three.min.js` (`npm run copy:three`, run by `dev` and
`build`) and the Three.js JSON meshes `ar-dynamic.html` loads. It goes when AR is redone.

Python checks live in `backend/`: `venv/bin/python test_catalogue.py`, `test_designs.py`,
`test_uploads.py`.

## Docs

Start at [PROJECT_OVERVIEW](../PROJECT_OVERVIEW.md) — it has the map and the current status.
