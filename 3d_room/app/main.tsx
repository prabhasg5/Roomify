// index.html: the app shell. Pick, load or save a design; edit its plan in 2D, its items
// and textures in 3D; add items from the catalogue, upload models to it; download the room as GLB.

import { useProgress, useTexture } from "@react-three/drei";
import { Canvas, events } from "@react-three/fiber";
import type { Intersection, Object3D } from "three";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { fromDesign, toDesign, type LegacyDesign } from "./core/design";
import { settle } from "./core/placement";
import { findRooms } from "./core/rooms";
import type { FloorTexture, PlacedItem, Vec3, WallTexture } from "./core/types";
import { buildEdges, wallSides } from "./core/walls";
import { ArExport, ModelUpload } from "./dialogs";
import { Floorplanner } from "./plan2d";
import { exportGlb, gizmoHot, Scene, surfaceUnder } from "./scene";
import { heavy, indexCatalogue, resolveModel, useViewer, type CatalogueProduct, type CatalogueVariant, type GizmoMode } from "./store";
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

/** A legacy design from text (a file, localStorage): replaces the current one, as old loadSerialized. */
function loadText(source: string, text: string) {
  const { load, addError } = useViewer.getState();
  try {
    const legacy = JSON.parse(text) as LegacyDesign;
    if (!legacy?.floorplan?.corners) throw new Error("not a design: no floorplan.corners");
    load(source, fromDesign(legacy));
    // Off the hash, so picking any listed design afterwards changes it and loads.
    history.replaceState(null, "", location.pathname + location.search);
  } catch (e) {
    addError(`${source}: ${(e as Error).message}`);
  }
}

/** /api/catalogue adds prices and uploads; the static file is the fallback when FastAPI is down (as old example.js). */
function loadCatalogue() {
  const json = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));
  return json("/api/catalogue")
    .catch(() => json("catalogue.json"))
    .then((cat) => useViewer.getState().setCatalogue(cat.products, indexCatalogue(cat)))
    .catch((e) => useViewer.getState().addError(`catalogue: ${e.message}`));
}

/** A download of `blob` as `name`. */
function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

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
  // Both tabs stay mounted over the same store, so neither loses its camera/view or the selection.
  const [tab, setTab] = useState<"3d" | "2d" | "items">("3d");
  const show = (next: typeof tab) => {
    setTab(next);
    useViewer.getState().pickSurface(null); // old TextureSelector resets on a tab change
  };
  // Save and GLB results, shared by the main controls and the sidebar's Download GLB.
  const [notice, setNotice] = useState("");
  useEffect(() => setNotice(""), [source]); // a save notice is about the design it saved

  // Old "Download GLB" saved the design JSON; this is the room itself.
  const downloadGlb = async () => {
    setNotice("Exporting GLB…");
    try {
      const glb = await exportGlb();
      download(new Blob([glb], { type: "model/gltf-binary" }), "room.glb");
      setNotice(`Downloaded room.glb (${(glb.byteLength / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {
      setNotice(`GLB export failed: ${(e as Error).message}`);
    }
  };
  const clearAll = () => {
    if (confirm("Remove all placed items from the 3D scene?")) useViewer.getState().clearItems();
  };

  useEffect(() => {
    loadCatalogue();
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

  const tabs: [typeof tab, string][] = [["2d", "Edit Floorplan"], ["3d", "Design"], ["items", "Add Items"]];
  return (
    <div className="app">
      {/* Old index.html's left column: nav, AR + GLB, Clear All, then the context menu or texture picker. */}
      <aside className="sidebar">
        <nav className="nav" role="tablist">
          {tabs.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => show(t)}>{label}</button>
          ))}
        </nav>
        <div className="actions">
          <ArExport className="ar block" />
          <button className="glb block" data-icon="⤓" onClick={downloadGlb}>Download GLB</button>
          {notice && <p className="notice" role="status">{notice}</p>}
        </div>
        <hr />
        <div className="clear">
          <button className="warning sm block" data-icon="⊗" onClick={clearAll}>Clear All Placed Items</button>
        </div>
        {tab === "3d" && <ItemPanel />}
        {tab === "3d" && <TexturePanel />}
        <SourcePicker />
      </aside>
      <div className="main">
        {errors.length > 0 && (
          <ul className="errors" role="alert">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        )}
        <main>
          {/* flat = no tone mapping, as r69. */}
          <Canvas
            flat camera={{ fov: 45, near: 1, far: 100000 }} events={(s) => ({ ...events(s), filter: onlyShown })} gl={{ preserveDrawingBuffer: true }} frameloop={tab === "3d" ? "always" : "never"}
            onPointerMissed={(e) => {
              if (e.button !== 0 || gizmoHot()) return;
              // Old controller: a click on no item deselects, then a wall side or floor opens its textures.
              useViewer.getState().select(null);
              useViewer.getState().pickSurface(surfaceUnder(e));
            }}
          >
            <Scene key={source} />
          </Canvas>
          {tab === "3d" && <MainControls onGlb={downloadGlb} say={setNotice} />}
          {tab === "3d" && <GizmoModes />}
          {tab === "items" && <CataloguePanel onAdded={() => show("3d")} />}
          <Floorplanner shown={tab === "2d"} onDone={() => show("3d")} />
        </main>
      </div>
    </div>
  );
}

/** The design picker (fixtures, saved, problem GLB; the URL hash), with the plan's size and the loading counter. */
function SourcePicker() {
  const source = useViewer((s) => s.source);
  const design = useViewer((s) => s.design);
  return (
    <div className="source">
      <label><strong>Roomify</strong> design file
        <select className="control" value={source} onChange={(e) => { location.hash = e.target.value; }}>
          {!sources[source] && <option value={source}>{source}</option>}
          {Object.entries(sources).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </label>
      <small className="muted">
        {design && `${design.walls.length} walls · ${design.items.length} items`} <Progress />
      </small>
    </div>
  );
}

// Three raycasts hidden objects too: an in-wall item hidden with its cut-away wall would still
// swallow the click, so the floor or wall behind it never got onPointerMissed.
const shown = (o: Object3D | null): boolean => !o || (o.visible && shown(o.parent));
const onlyShown = (hits: Intersection[]) => hits.filter((h) => shown(h.object));

const IN = 2.54;
const dimsToSize = (d: CatalogueVariant["dimensions"]): Vec3 | undefined => d && { x: d.width, y: d.height, z: d.depth };

/** The old context menu: name, delete, size in inches, lock in place; plus gizmo mode and variant. */
function ItemPanel() {
  const { design, selected, models, sizes, updateItem, deleteItem } = useViewer();
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
    <section className="context-menu" aria-label="Selected item">
      <span className="lead">{item.name}</span>
      {variants.length > 1 && (
        <label className="field">Variant
          <select className="control" value={item.variantId} onChange={(e) => swapVariant(e.target.value)}>
            {variants.map((v) => <option key={v.id} value={v.id}>{v.label ?? v.id}</option>)}
          </select>
        </label>
      )}
      <button className="danger block" data-icon="✕" onClick={() => deleteItem(index)}>Delete Item</button>
      <fieldset className="box" disabled={!size} aria-label="Adjust Size">
        <div className="box-head">Adjust Size</div>
        <div className="box-body">
          {dims.map(([axis, label]) => {
            const value = size ? ((size[axis] * item.scale[axis]) / IN).toFixed(0) : "";
            return (
              <label key={axis} className="row">{label}
                <input
                  key={`${index}:${value}`} className="control" type="number" min={1} defaultValue={value}
                  onBlur={(e) => e.target.value !== value && resize(axis, Number(e.target.value))}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              </label>
            );
          })}
          <small className="muted">Measurements in inches.</small>
        </div>
      </fieldset>
      <label className="check"><input type="checkbox" checked={item.fixed} onChange={(e) => updateItem(index, { fixed: e.target.checked })} /> Lock in place</label>
    </section>
  );
}

/** Old camera-controls' gizmo group (bottom right of the 3D view); T / R / S do the same. */
function GizmoModes() {
  const { gizmo, setGizmo } = useViewer();
  const icons = { translate: "✥", rotate: "↻", scale: "⤢" };
  return (
    <div className="camera-controls" role="group" aria-label="Gizmo">
      {(["translate", "rotate", "scale"] as const).map((m) => (
        <button key={m} aria-pressed={gizmo === m} onClick={() => setGizmo(m)} title={`${m[0].toUpperCase()}${m.slice(1)} (${m[0].toUpperCase()})`} aria-label={m}>{icons[m]}</button>
      ))}
    </div>
  );
}

/** Old main-controls: New Plan, Save Plan, Load Plan, Export to AR, Download GLB; plus the two saves old "Export to AR" did. */
function MainControls({ onGlb, say: setNotice }: { onGlb: () => void; say: (notice: string) => void }) {
  const legacy = () => {
    const d = useViewer.getState().design;
    return d ? JSON.stringify(toDesign(d)) : null;
  };
  const saveFile = () => {
    const data = legacy();
    if (data) download(new Blob([data], { type: "text" }), "design.blueprint3d");
  };
  const saveBrowser = () => {
    const data = legacy();
    if (!data) return;
    localStorage.setItem(STORAGE_KEY, data);
    setNotice(`Saved to this browser (localStorage '${STORAGE_KEY}')`);
  };
  const saveServer = async () => {
    const data = legacy();
    if (!data) return;
    try {
      const r = await fetch("/api/designs", { method: "POST", headers: { "Content-Type": "application/json" }, body: data });
      const body = await r.json().catch(() => ({}));
      setNotice(r.ok ? `Saved to server: ${body.filename}` : `Server refused the design: HTTP ${r.status} ${body.detail ?? ""}`);
    } catch (e) {
      setNotice(`Could not reach the server: ${(e as Error).message}`);
    }
  };
  const newPlan = () => {
    history.replaceState(null, "", `#${DEFAULT_SOURCE}`);
    loadSource(DEFAULT_SOURCE);
  };
  return (
    <div className="main-controls">
      <button className="sm" onClick={newPlan}>New Plan</button>
      <button className="sm" onClick={saveFile}>Save Plan</button>
      <label className="button sm">Load Plan
        <input
          type="file" hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // the same file again still fires change
            if (file) loadText(`file: ${file.name}`, await file.text());
          }}
        />
      </label>
      <button className="sm" onClick={saveBrowser}>Save to Browser</button>
      <button className="sm" onClick={saveServer}>Save to Server</button>
      <ArExport className="ar sm" />
      <button className="glb sm" data-icon="⤓" onClick={onGlb}>Download GLB</button>
    </div>
  );
}

const IN_RUPEES = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

/** Old "Add Items" tab, now from the catalogue (uploads included): one card per variant; a click places it and selects it. */
function CataloguePanel({ onAdded }: { onAdded: () => void }) {
  const { products, sizes, addItem, design } = useViewer();
  const add = (p: CatalogueProduct, v: CatalogueVariant, name: string) => {
    const size = (v.glb && sizes[v.glb]) || dimsToSize(v.dimensions);
    if (!design || !size) return;
    addItem({
      name, type: p.item_type, productId: p.id, variantId: v.id,
      // The old app loads by model_url, so it gets the variant's legacy mesh url.
      modelUrl: v.model ?? v.glb,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, fixed: false,
    }, size);
    onAdded();
  };
  // Old deleteUserModel(). Designs that use it still load; the item shows in the error bar.
  const remove = async (p: CatalogueProduct) => {
    if (!confirm(`Delete "${p.name}"? This cannot be undone. Saved designs that use it will show it as missing.`)) return;
    const r = await fetch(`/api/uploads/${encodeURIComponent(p.id)}`, { method: "DELETE" }).catch(() => null);
    if (!r?.ok) useViewer.getState().addError(`Failed to delete model "${p.name}": ${r ? `HTTP ${r.status}` : "server unreachable"}`);
    loadCatalogue();
  };
  // Only what POST /api/uploads stored can be deleted (couch and sofa-2 are catalogue builds).
  const uploaded = (v: CatalogueVariant) => !!v.glb?.startsWith("models/uploads/");
  const cards = (mine: boolean) => products.flatMap((p) => p.variants.filter((v) => v.glb && uploaded(v) === mine).map((v) => {
    const name = p.variants.length > 1 ? `${p.name} - ${v.label ?? v.id}` : p.name;
    const price = p.price != null ? p.price + (v.price_delta ?? 0) : null;
    const warn = heavy(v.stats);
    return (
      <div key={`${p.id}/${v.id}`} className="card-wrap">
        <button className="card" onClick={() => add(p, v, name)} disabled={!design}>
          {v.thumbnail && <img src={v.thumbnail} alt="" loading="lazy" />}
          <span className="name">{name}</span>
          {price != null && <span className="price">{IN_RUPEES.format(price)}</span>}
          {warn.length > 0 && <span className="heavy" title={warn.join("\n")}>⚠ heavy model: {warn.join(", ")}</span>}
        </button>
        {mine && <button className="remove" title="Delete" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}>&times;</button>}
      </div>
    );
  }));
  const mine = cards(true);
  return (
    <section className="catalogue" aria-label="Catalogue">
      <div className="upload-bar"><ModelUpload onUploaded={loadCatalogue} /></div>
      {mine.length > 0 && (
        <>
          <h5>My Uploaded Models</h5>
          <div className="cards">{mine}</div>
          <hr />
        </>
      )}
      <h5>Built-in Models</h5>
      <div className="cards">{cards(false)}</div>
    </section>
  );
}

// Old index.html's texture thumbnails, attributes as written there. texture-scale="" parsed to NaN,
// which the old app saved as null: kept so both apps write the same design.
const WALL_TEXTURES: (WallTexture & { thumb: string })[] = [
  { url: "rooms/textures/marbletiles.jpg", stretch: false, scale: 300, thumb: "rooms/thumbnails/thumbnail_marbletiles.jpg" },
  { url: "rooms/textures/wallmap_yellow.png", stretch: true, scale: NaN, thumb: "rooms/thumbnails/thumbnail_wallmap_yellow.png" },
  { url: "rooms/textures/light_brick.jpg", stretch: false, scale: 100, thumb: "rooms/thumbnails/thumbnail_light_brick.jpg" },
];
const FLOOR_TEXTURES: (FloorTexture & { thumb: string })[] = [
  { url: "rooms/textures/light_fine_wood.jpg", scale: 300, thumb: "rooms/thumbnails/thumbnail_light_fine_wood.jpg" },
];
// So the first pick doesn't blank the walls while it loads (the walls suspend on a new texture).
for (const t of [...WALL_TEXTURES, ...FLOOR_TEXTURES]) useTexture.preload(t.url);

/** Old "Adjust Wall" / "Adjust Floor": shown for the wall side or floor last clicked. */
function TexturePanel() {
  const { surface, setTexture } = useViewer();
  if (!surface) return null;
  const options = surface.kind === "wall" ? WALL_TEXTURES : FLOOR_TEXTURES;
  return (
    <section className="box textures-box" aria-label="Textures">
      <div className="box-head">{surface.kind === "wall" ? "Adjust Wall" : "Adjust Floor"}</div>
      <div className="box-body textures">
        {options.map(({ thumb, ...texture }) => (
          <button key={texture.url} className="thumbnail" onClick={() => setTexture(surface, texture)} title={texture.url}>
            <img src={thumb} alt={texture.url.split("/").pop()} />
          </button>
        ))}
      </div>
    </section>
  );
}

function Progress() {
  const { active, loaded, total } = useProgress();
  return active ? <span className="muted">Loading {loaded}/{total}…</span> : null;
}

createRoot(document.getElementById("root")!).render(<App />);
