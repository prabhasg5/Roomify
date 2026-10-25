// next.html: the stage-2 app shell. Pick, load or save a design; edit its plan in 2D, its items
// and textures in 3D; add items from the catalogue.

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
import { ArExport } from "./dialogs";
import { Floorplanner } from "./plan2d";
import { gizmoHot, Scene, surfaceUnder } from "./scene";
import { indexCatalogue, resolveModel, useViewer, type CatalogueProduct, type CatalogueVariant, type GizmoMode } from "./store";
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
  // Both tabs stay mounted over the same store, so neither loses its camera/view or the selection.
  const [tab, setTab] = useState<"3d" | "2d" | "items">("3d");
  const show = (next: typeof tab) => {
    setTab(next);
    useViewer.getState().pickSurface(null); // old TextureSelector resets on a tab change
  };

  useEffect(() => {
    // /api/catalogue adds prices; the static file is the fallback when FastAPI is down (as old example.js).
    const json = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));
    json("/api/catalogue")
      .catch(() => json("catalogue.json"))
      .then((cat) => useViewer.getState().setCatalogue(cat.products, indexCatalogue(cat)))
      .catch((e) => useViewer.getState().addError(`catalogue: ${e.message}`));
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
        <strong>Roomify</strong> <span className="muted">next</span>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "3d"} onClick={() => show("3d")}>3D view</button>
          <button role="tab" aria-selected={tab === "2d"} onClick={() => show("2d")}>2D floorplan</button>
          <button role="tab" aria-selected={tab === "items"} onClick={() => show("items")}>Add items</button>
        </div>
        <select value={source} onChange={(e) => { location.hash = e.target.value; }} aria-label="Design">
          {!sources[source] && <option value={source}>{source}</option>}
          {Object.entries(sources).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <FileMenu />
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
        {tab === "3d" && <ItemPanel />}
        {tab === "3d" && <TexturePanel />}
        {tab === "items" && <CataloguePanel onAdded={() => show("3d")} />}
        <Floorplanner shown={tab === "2d"} />
      </main>
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

/** Old main-controls: New Plan, Save Plan, Load Plan; plus the two saves old "Export to AR" did, and Clear All. */
function FileMenu() {
  const [notice, setNotice] = useState("");
  const source = useViewer((s) => s.source);
  useEffect(() => setNotice(""), [source]); // a save notice is about the design it saved
  const legacy = () => {
    const d = useViewer.getState().design;
    return d ? JSON.stringify(toDesign(d)) : null;
  };
  const saveFile = () => {
    const data = legacy();
    if (!data) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "text" }));
    a.download = "design.blueprint3d";
    a.click();
    URL.revokeObjectURL(a.href);
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
  const clearAll = () => {
    if (confirm("Remove all placed items from the 3D scene?")) useViewer.getState().clearItems();
  };
  return (
    <span className="file-menu">
      <button onClick={newPlan}>New plan</button>
      <button onClick={saveFile}>Save plan</button>
      <label className="button">Load plan
        <input
          type="file" hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // the same file again still fires change
            if (file) loadText(`file: ${file.name}`, await file.text());
          }}
        />
      </label>
      <button onClick={saveBrowser}>Save to browser</button>
      <button onClick={saveServer}>Save to server</button>
      <ArExport />
      <button className="warning" onClick={clearAll}>Clear all placed items</button>
      {notice && <span className="muted" role="status">{notice}</span>}
    </span>
  );
}

const IN_RUPEES = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

/** Old "Add Items" tab, now from the catalogue: one card per variant; a click places it and selects it. */
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
  return (
    <section className="catalogue" aria-label="Catalogue">
      {products.flatMap((p) => p.variants.filter((v) => v.glb).map((v) => {
        const name = p.variants.length > 1 ? `${p.name} - ${v.label ?? v.id}` : p.name;
        const price = p.price != null ? p.price + (v.price_delta ?? 0) : null;
        return (
          <button key={`${p.id}/${v.id}`} className="card" onClick={() => add(p, v, name)} disabled={!design}>
            {v.thumbnail && <img src={v.thumbnail} alt="" loading="lazy" />}
            <span>{name}</span>
            {price != null && <span className="price">{IN_RUPEES.format(price)}</span>}
          </button>
        );
      }))}
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
    <aside className="panel" aria-label="Textures">
      <strong>{surface.kind === "wall" ? "Adjust wall" : "Adjust floor"}</strong>
      <div className="textures">
        {options.map(({ thumb, ...texture }) => (
          <button key={texture.url} onClick={() => setTexture(surface, texture)} title={texture.url}>
            <img src={thumb} alt={texture.url.split("/").pop()} />
          </button>
        ))}
      </div>
    </aside>
  );
}

function Progress() {
  const { active, loaded, total } = useProgress();
  return active ? <span className="muted">Loading {loaded}/{total}…</span> : null;
}

createRoot(document.getElementById("root")!).render(<App />);
