// next.html: the stage-2 app shell. For now a read-only viewer: pick a design, look at it in 3D.

import { useProgress } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { fromDesign, type LegacyDesign } from "./core/design";
import { Scene } from "./scene";
import { indexCatalogue, useViewer } from "./store";
import "./app.css";

const fixtures = import.meta.glob<LegacyDesign>("./fixtures/*.design.json", { import: "default" });
const fixtureName = (path: string) => path.replace("./fixtures/", "").replace(".design.json", "");
const STORAGE_KEY = "ar_room_design";
const PROBLEM_GLB = "models/glb/white-sofa-1790761067934.glb";

/** Sources by picker value (also the URL hash, so a design can be linked). */
const sources: Record<string, { label: string; get: () => Promise<LegacyDesign> }> = {
  ...Object.fromEntries(Object.entries(fixtures).map(([path, get]) => [fixtureName(path), { label: fixtureName(path), get }])),
  saved: {
    label: `Saved design (localStorage '${STORAGE_KEY}')`,
    get: async () => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) throw new Error(`localStorage['${STORAGE_KEY}'] is empty: use "View in AR" in the old app to save one`);
      return JSON.parse(raw);
    },
  },
  "problem-glb": {
    label: "Problem GLB (white sofa, direct URL)",
    // The raw upload (git-ignored) in the default room. It's in metres, hence ×100.
    get: async () => {
      const room = await fixtures["./fixtures/default-room.design.json"]();
      return {
        ...room,
        items: [{
          item_name: "White sofa (problem GLB)", item_type: 1, glb_url: PROBLEM_GLB,
          xpos: 438.53, ypos: 13, zpos: 55.37, rotation: 0, rotation_x: 0, rotation_y: 0, rotation_z: 0,
          scale_x: 100, scale_y: 100, scale_z: 100, fixed: false,
        }],
      };
    },
  },
};
const DEFAULT_SOURCE = "default-room";

async function loadSource(name: string) {
  const { load, addError } = useViewer.getState();
  const src = sources[name] ?? sources[DEFAULT_SOURCE];
  try {
    const legacy = await src.get();
    if (!legacy?.floorplan?.corners) throw new Error("not a design: no floorplan.corners");
    load(name, fromDesign(legacy));
  } catch (e) {
    load(name, null);
    addError(`${src.label}: ${(e as Error).message}`);
  }
}

function App() {
  const source = useViewer((s) => s.source);
  const errors = useViewer((s) => s.errors);
  const design = useViewer((s) => s.design);

  useEffect(() => {
    fetch("catalogue.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((cat) => useViewer.getState().setModels(indexCatalogue(cat)))
      .catch((e) => useViewer.getState().addError(`catalogue.json: ${e.message}`));
    const fromHash = () => loadSource(decodeURIComponent(location.hash.slice(1)) || DEFAULT_SOURCE);
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  return (
    <div className="app">
      <header>
        <strong>Roomify</strong> <span className="muted">next · read-only viewer</span>
        <select value={source} onChange={(e) => { location.hash = e.target.value; }} aria-label="Design">
          {Object.entries(sources).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        {design && <span className="muted">{design.walls.length} walls · {design.items.length} items</span>}
        <Progress />
      </header>
      {errors.length > 0 && (
        <ul className="errors" role="alert">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      <main>
        {/* flat = no tone mapping, as r69. */}
        <Canvas flat camera={{ fov: 45, near: 1, far: 100000 }} gl={{ preserveDrawingBuffer: true }}>
          <Scene key={source} />
        </Canvas>
      </main>
    </div>
  );
}

function Progress() {
  const { active, loaded, total } = useProgress();
  return active ? <span className="muted">Loading {loaded}/{total}…</span> : null;
}

createRoot(document.getElementById("root")!).render(<App />);
