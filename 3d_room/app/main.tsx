// next.html: the stage-2 app shell. Pick a design, edit its items in 3D.

import { useProgress } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { fromDesign, type LegacyDesign } from "./core/design";
import { settle } from "./core/placement";
import { findRooms } from "./core/rooms";
import type { PlacedItem, Vec3 } from "./core/types";
import { buildEdges, wallSides } from "./core/walls";
import { gizmoHot, Scene } from "./scene";
import { indexCatalogue, resolveModel, useViewer, type CatalogueVariant, type GizmoMode } from "./store";
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
    // Old example.js: T / R / S pick the gizmo mode.
    const keys: Record<string, GizmoMode> = { t: "translate", r: "rotate", s: "scale" };
    const onKey = (e: KeyboardEvent) => {
      const mode = keys[e.key.toLowerCase()];
      if (mode && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) useViewer.getState().setGizmo(mode);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="app">
      <header>
        <strong>Roomify</strong> <span className="muted">next · 3D editor</span>
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
        <Canvas
          flat camera={{ fov: 45, near: 1, far: 100000 }} gl={{ preserveDrawingBuffer: true }}
          onPointerMissed={(e) => { if (e.button === 0 && !gizmoHot()) useViewer.getState().select(null); }}
        >
          <Scene key={source} />
        </Canvas>
        <ItemPanel />
      </main>
    </div>
  );
}

const IN = 2.54;
const dimsToSize = (d: CatalogueVariant["dimensions"]): Vec3 | undefined => d && { x: d.width, y: d.height, z: d.depth };

/** The old context menu: name, delete, size in inches, lock in place; plus gizmo mode and variant. */
function ItemPanel() {
  const { design, selected, models, sizes, gizmo, setGizmo, updateItem, deleteItem } = useViewer();
  if (!design || selected === null || !design.items[selected]) return null;
  const index = selected;
  const item = design.items[index];
  const url = models ? resolveModel(item, models) : undefined;
  const size = url ? sizes[url] : undefined;
  const variants = (item.productId && models?.variants.get(item.productId)) || [];

  // Size or variant changed: put it back on the floor / its wall, as the old resized() did.
  const edit = (next: PlacedItem, size: Vec3) => {
    const sides = wallSides(buildEdges(design, findRooms(design)));
    updateItem(index, { ...next, ...settle(next, size, design, sides) });
  };
  const resize = (axis: keyof Vec3, inches: number) => {
    if (!size || !(inches > 0)) return;
    edit({ ...item, scale: { ...item.scale, [axis]: (inches * IN) / size[axis] } }, size);
  };
  const swapVariant = (id: string) => {
    const v = variants.find((v) => v.id === id);
    const vSize = v?.glb ? (sizes[v.glb] ?? dimsToSize(v.dimensions)) : undefined;
    // model_url follows the variant so the old app (which loads by model_url) shows the same one.
    const next = { ...item, variantId: id, modelUrl: v?.model ?? v?.glb ?? item.modelUrl };
    if (vSize) edit(next, vSize);
    else updateItem(index, next);
  };
  const dims: [keyof Vec3, string][] = [["x", "Width"], ["z", "Depth"], ["y", "Height"]];

  return (
    <aside className="panel" aria-label="Selected item">
      <strong>{item.name}</strong>
      <div className="modes" role="group" aria-label="Gizmo">
        {(["translate", "rotate", "scale"] as const).map((m) => (
          <button key={m} aria-pressed={gizmo === m} onClick={() => setGizmo(m)} title={`${m} (${m[0].toUpperCase()})`}>{m}</button>
        ))}
      </div>
      {variants.length > 1 && (
        <label>Variant{" "}
          <select value={item.variantId} onChange={(e) => swapVariant(e.target.value)}>
            {variants.map((v) => <option key={v.id} value={v.id}>{v.label ?? v.id}</option>)}
          </select>
        </label>
      )}
      <fieldset disabled={!size}>
        <legend>Size (inches)</legend>
        {dims.map(([axis, label]) => {
          const value = size ? ((size[axis] * item.scale[axis]) / IN).toFixed(0) : "";
          return (
            <label key={axis}>{label}{" "}
              <input
                key={`${index}:${value}`} type="number" min={1} defaultValue={value}
                onBlur={(e) => e.target.value !== value && resize(axis, Number(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            </label>
          );
        })}
      </fieldset>
      <label><input type="checkbox" checked={item.fixed} onChange={(e) => updateItem(index, { fixed: e.target.checked })} /> Lock in place</label>
      <button className="danger" onClick={() => deleteItem(index)}>Delete item</button>
    </aside>
  );
}

function Progress() {
  const { active, loaded, total } = useProgress();
  return active ? <span className="muted">Loading {loaded}/{total}…</span> : null;
}

createRoot(document.getElementById("root")!).render(<App />);
