// The modal flows from the old app: CAD import (cad-import-modal) and Export to AR (ar-modal)
// from example.js mainControls, model upload (upload-model-modal) from model-upload.js.
// Native <dialog>s; the importers are the ESM copies in core/.

import { useGLTF } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { CADImporter, type CadEntity, type CadHeader, type CadUnit } from "./core/cad-importer.js";
import { fromDesign, toDesign } from "./core/design";
import { DWGImporter } from "./core/dwg-importer.js";
import { Report } from "./scene";
import { heavy, useViewer, type CatalogueProduct } from "./store";

const STORAGE_KEY = "ar_room_design";

function Modal({ dialog, title, onClose, children, footer, tone = "" }: {
  dialog: React.RefObject<HTMLDialogElement | null>;
  /** Old header look: "" (plain Bootstrap modal), "cad" (cyan gradient), "ar" (purple gradient). */
  tone?: string;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    // A click on the dialog element itself is a click on its backdrop (old .cad-modal-backdrop).
    <dialog ref={dialog} className={`modal ${tone}`} onClose={onClose} onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}>
      <header>
        <h4>{title}</h4>
        <button className="close" aria-label="Close" onClick={() => dialog.current?.close()}>&times;</button>
      </header>
      <div className="body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
}

const UNITS: [CadUnit, string][] = [["cm", "Centimeters"], ["mm", "Millimeters"], ["m", "Meters"], ["in", "Inches"], ["ft", "Feet"]];

/** Old "Import CAD": pick a .dxf/.dwg, review the summary and settings, replace the plan with it. */
export function CadImport() {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<{ entities: CadEntity[]; header: CadHeader } | null>(null);
  const [error, setError] = useState("");
  // Kept across imports like the old <select>; the layer filter is reset on close.
  const [unit, setUnit] = useState<CadUnit>("ft");
  const [layers, setLayers] = useState("");
  const [collapse, setCollapse] = useState(true);
  const [notice, setNotice] = useState("");

  const open = () => { if (!dialog.current?.open) dialog.current?.showModal(); };
  const reset = () => {
    setParsed(null);
    setFileName("");
    setError("");
    setLayers("");
    if (input.current) input.current.value = "";
  };

  // Old showCADSummary(): auto-detect the unit, pre-fill the wall layers.
  const summarise = (name: string, p: { entities: CadEntity[]; header: CadHeader }) => {
    setFileName(name);
    setParsed(p);
    const detected = CADImporter.detectUnit(p.header);
    if (detected) setUnit(detected);
    const walls = CADImporter.detectWallLayers(p.entities);
    if (walls.length) setLayers((l) => l || walls.join(", "));
  };

  const pick = async (file: File) => {
    setNotice("");
    setError("");
    setParsed(null);
    setFileName(file.name);
    const ext = file.name.split(".").pop()!.toLowerCase();
    if (ext !== "dxf" && ext !== "dwg") {
      setError(`Unsupported file format ".${ext}". Please upload a .dxf or .dwg file.`);
      return open();
    }
    if (ext === "dxf") {
      try {
        summarise(file.name, CADImporter.parseDxf(await file.text()));
      } catch (e) {
        setError(`Error reading DXF file: ${(e as Error).message}`);
      }
      return open();
    }
    // The wasm parse is slow: show the modal straight away.
    setFileName(`${file.name} (decoding DWG…)`);
    open();
    try {
      summarise(file.name, await DWGImporter.parse(await file.arrayBuffer()));
    } catch (e) {
      setFileName(file.name);
      setError(`Error reading DWG file: ${(e as Error).message}`);
    }
  };

  const importPlan = () => {
    if (!parsed) return setError("No file loaded. Please select a DXF or DWG file.");
    try {
      const legacy = CADImporter.entitiesToBlueprint(parsed.entities, unit, layers, { collapseWalls: collapse });
      const corners = Object.keys(legacy.floorplan.corners).length;
      const walls = legacy.floorplan.walls.length;
      if (corners < 2 || walls < 1) {
        return setError(`The import produced too few walls (${walls} walls, ${corners} corners). Try different settings.`);
      }
      useViewer.getState().load(`cad: ${fileName}`, fromDesign(legacy));
      history.replaceState(null, "", location.pathname + location.search); // off the picker's hash
      dialog.current?.close();
      setNotice(`CAD file imported: ${corners} corners, ${walls} walls.`);
    } catch (e) {
      setError(`Import failed: ${(e as Error).message}`);
    }
  };

  const summary = parsed && CADImporter.getEntitiesSummary(parsed.entities);
  return (
    <>
      <input ref={input} type="file" accept=".dxf,.dwg" hidden onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      <button className="info sm import-cad" data-icon="⇪" onClick={() => input.current?.click()} title="Import a DXF or DWG CAD file as floorplan">Import CAD</button>
      {notice && <span className="notice" role="status">{notice}</span>}
      <Modal
        dialog={dialog} title={<span data-icon="⇪">Import CAD File</span>} onClose={reset} tone="cad"
        footer={<>
          <button onClick={() => dialog.current?.close()}>Cancel</button>
          <button className="success" data-icon="⤓" disabled={!parsed} onClick={importPlan}>Import Floorplan</button>
        </>}
      >
        {fileName && <p className="alert info"><strong>File:</strong> {fileName}</p>}
        {summary && (
          <>
            <section className="box">
              <div className="box-head">{fileName.toLowerCase().endsWith(".dwg") ? "DWG" : "DXF"} File Summary</div>
              <div className="box-body">
                <p><strong>Total entities:</strong> {summary.totalEntities}</p>
                <p><strong>Entity types:</strong> {Object.entries(summary.entityTypes).map(([t, n]) => `${t} (${n})`).join(", ")}</p>
              </div>
            </section>
            {summary.layers.length > 0 && (
              <section className="box">
                <div className="box-head">Layers Found</div>
                <div className="box-body layers">
                  {summary.layers.map((l) => (
                    <div key={l.name} className="layer">
                      <strong>{l.name}</strong> <span className="badge">{l.entityCount} entities</span><br />
                      <small className="muted">{l.entityTypes}</small>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
        <section className="box">
          <div className="box-head">Import Settings</div>
          <div className="box-body">
            <label className="field">Source units in CAD file:
              <select className="control" value={unit} onChange={(e) => setUnit(e.target.value as CadUnit)}>
                {UNITS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </label>
            <label className="field">Layer filter (leave empty for all layers):
              <input className="control" value={layers} onChange={(e) => setLayers(e.target.value)} placeholder="e.g. A-WALL, WALL" />
              <small className="muted">Comma-separated layer names. Only entities on these layers will be imported. Wall layers are auto-filled when detected.</small>
            </label>
            <label className="check"><input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} /> <strong>Collapse double-line walls</strong> (recommended for architectural plans)
              <br /><small className="muted">Merges the two parallel lines of each wall into a single centerline. Turn off for plans drawn with single-line walls.</small>
            </label>
          </div>
        </section>
        {error && <p className="alert danger" role="alert">{error}</p>}
      </Modal>
    </>
  );
}

// qrcode@1.5.1 from jsDelivr on first use, as old ar-exporter.js generateQRCode did.
declare global {
  interface Window {
    QRCode?: { toCanvas(canvas: HTMLCanvasElement, text: string, opts: { width: number; margin: number }, cb: (e?: Error) => void): void };
  }
}
let qrLib: Promise<NonNullable<Window["QRCode"]>> | null = null;
const loadQr = () =>
  (qrLib ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js";
    s.onload = () => (window.QRCode ? resolve(window.QRCode) : reject(new Error("no QRCode global")));
    s.onerror = () => { qrLib = null; reject(new Error("could not load")); };
    document.head.appendChild(s);
  }));

interface NetworkInfo { ip?: string; arUrl?: string; localUrl?: string }

/** Old "Export to AR": save for the AR page, show the phone URL as a QR code, post to the server. */
export function ArExport({ className = "" }: { className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ items: number; mobileUrl: string; localUrl: string; server: string; qr: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const exportToAR = async () => {
    const design = useViewer.getState().design;
    if (!design) return;
    const data = JSON.stringify(toDesign(design));
    localStorage.setItem(STORAGE_KEY, data);
    setState(null);
    dialog.current?.showModal(); // "Exporting your room design..."

    // Same-origin through the Vite proxy; the backend that answers serves the AR pages.
    const info: NetworkInfo = await fetch("/api/network-info")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .catch(() => ({ ip: "YOUR_IP", arUrl: "https://YOUR_IP:8002/ar-mobile.html", localUrl: "http://localhost:8080/ar-mobile.html" }));
    const localUrl = info.localUrl || "http://localhost:8080/ar-mobile.html";
    const mobileUrl = info.arUrl || `https://${info.ip}:8002/ar-mobile.html`;

    // The phone reads the newest saved design from /current-design.
    const server = await fetch("/api/designs", { method: "POST", headers: { "Content-Type": "application/json" }, body: data })
      .then(async (r) => (r.ok ? `Saved to server as ${(await r.json()).filename}` : `Server refused the design (HTTP ${r.status})`))
      .catch((e) => `Could not save to server: ${e.message}`);
    setState({ items: design.items.length, mobileUrl, localUrl, server, qr: "" });
    window.open(localUrl, "_blank");
  };

  // The QR canvas exists once the success view renders.
  const drawQr = (canvas: HTMLCanvasElement | null) => {
    if (!canvas || !state || canvas.dataset.url === state.mobileUrl) return;
    canvas.dataset.url = state.mobileUrl;
    loadQr()
      .then((QR) => QR.toCanvas(canvas, state.mobileUrl, { width: 200, margin: 2 }, (e) => e && setState((s) => s && { ...s, qr: "QR Code generation failed" })))
      .catch(() => setState((s) => s && { ...s, qr: "Could not load QR code library" }));
  };

  const copy = async () => {
    if (!state) return;
    await navigator.clipboard.writeText(state.mobileUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <button className={className} data-icon="phone" onClick={exportToAR}>Export to AR</button>
      <Modal
        dialog={dialog} title={<span data-icon="phone">View in AR</span>} onClose={() => setState(null)} tone="ar"
        footer={<button onClick={() => dialog.current?.close()}>Close</button>}
      >
        {!state ? (
          <p className="loading">Exporting your room design...</p>
        ) : (
          <>
            <p className="alert success"><strong>Success!</strong> Your room design is ready for AR viewing ({state.items} items).</p>
            <div className="qr">
              {state.qr ? <p className="alert danger">{state.qr}</p> : <canvas ref={drawQr} />}
            </div>
            <p className="muted center">Scan this QR code with your mobile device, or visit:</p>
            <div className="url">
              <input className="control" readOnly value={state.mobileUrl} onFocus={(e) => e.target.select()} aria-label="AR URL" />
              <button onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
            </div>
            <p className="muted">On this computer: <a href={state.localUrl} target="_blank" rel="noreferrer">{state.localUrl}</a></p>
            <p className="muted">{state.server}</p>
            <div className="alert info">
              <strong>Instructions:</strong>
              <ol>
                <li>Connect your mobile device to the same WiFi network</li>
                <li>Scan the QR code or enter the URL</li>
                <li>Accept any security warnings (self-signed certificate)</li>
                <li>Tap "View in AR" and point at a flat surface</li>
              </ol>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

const ITEM_TYPES: [number, string][] = [
  [1, "Floor Item (furniture, lamps, etc.)"], [2, "Wall Item (pictures, shelves, etc.)"], [3, "In-Wall Item (windows)"],
  [7, "In-Wall Floor Item (doors)"], [8, "On-Floor Item (rugs, carpets)"], [9, "Wall-Floor Item"],
];
const SCALES: [string, string][] = [
  ["auto", "Auto-detect (recommended)"], ["100", "Meters → Centimeters (×100)"], ["10", "Decimeters → Centimeters (×10)"],
  ["1", "No scaling (×1)"], ["2.54", "Inches → Centimeters (×2.54)"], ["30.48", "Feet → Centimeters (×30.48)"],
];

/** Old model-upload.js: "Couch_v2.glb" → "Couch V2". */
const nameFrom = (file: string) => file.replace(/\.(glb|gltf)$/i, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Old "Upload 3D Model" (minus Texture Image): POST /api/uploads, which stores the GLB as uploaded.
 * The model is previewed in a small canvas first; that render is the thumbnail unless one is picked.
 */
export function ModelUpload({ onUploaded }: { onUploaded: (product: CatalogueProduct) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [model, setModel] = useState<{ file: File; url: string } | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("1");
  const [scale, setScale] = useState("auto");
  const [thumb, setThumb] = useState<File | null>(null);
  const [preview, setPreview] = useState<"loading" | "ready" | "failed">("loading");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const pickModel = (file: File | undefined) => {
    if (model) URL.revokeObjectURL(model.url);
    setModel(file ? { file, url: URL.createObjectURL(file) } : null);
    setPreview("loading");
    setError("");
    if (file && !name) setName(nameFrom(file.name));
  };
  const open = () => {
    form.current?.reset(); // old resetUploadForm()
    pickModel(undefined);
    setName("");
    setType("1");
    setScale("auto");
    setThumb(null);
    setProgress(null);
    setDone("");
    dialog.current?.showModal();
  };

  const submit = async () => {
    setError("");
    setDone("");
    if (!model) return setError("Please select a .glb file");
    if (!name.trim()) return setError("Please enter a display name");
    if (!/\.glb$/i.test(model.file.name)) return setError("Only .glb files are supported");
    const body = new FormData();
    body.append("model", model.file);
    body.append("name", name.trim());
    body.append("type", type);
    body.append("scale", scale);
    const rendered = thumb ?? (await new Promise<Blob | null>((r) => canvas.current ? canvas.current.toBlob(r, "image/png") : r(null)));
    if (rendered) body.append("thumbnail", rendered, thumb?.name ?? "thumbnail.png");
    setProgress(0);
    try {
      const res = await post("/api/uploads", body, setProgress);
      if (res.status !== 200) {
        const d = res.body.detail;
        throw new Error(typeof d === "string" ? d : Array.isArray(d) ? `${d[0]?.loc?.join(".")}: ${d[0]?.msg}` : `HTTP ${res.status}`);
      }
      const product = res.body as CatalogueProduct;
      const warn = heavy(product.variants[0]?.stats);
      setDone(`Model "${product.name}" added to the catalogue as ${product.id}.` +
        (warn.length ? ` Heavy model (${warn.join(", ")}): it may load slowly; it is stored unchanged.` : ""));
      onUploaded(product);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <>
      <button className="primary block" data-icon="⇪" onClick={open}>Upload 3D Model (.glb)</button>
      <Modal
        dialog={dialog} title={<span data-icon="⇪">Upload 3D Model</span>} onClose={() => pickModel(undefined)}
        footer={<>
          <button onClick={() => dialog.current?.close()}>Close</button>
          <button className="primary" data-icon="⇪" onClick={submit} disabled={progress !== null || (!!model && preview !== "ready")}>Upload &amp; Add</button>
        </>}
      >
        <form ref={form} onSubmit={(e) => e.preventDefault()} className="upload-form">
          <label>3D Model File (.glb)
            <input className="control" type="file" accept=".glb" onChange={(e) => pickModel(e.target.files?.[0])} />
            <small className="muted">Max file size: 100MB. Stored exactly as uploaded.</small>
          </label>
          {model && (
            <div className="preview">
              <Canvas
                flat gl={{ preserveDrawingBuffer: true }} camera={{ fov: 45 }} frameloop="demand"
                onCreated={({ gl }) => { canvas.current = gl.domElement; }}
              >
                <hemisphereLight args={[0xffffff, 0x888888, 1.1 * Math.PI]} position={[0, 300, 0]} />
                <Report what={model.file.name} onError={(m) => { setPreview("failed"); setError(`Can't load this model: ${m}`); }}>
                  <Suspense fallback={null}>
                    <Preview url={model.url} onReady={() => setPreview("ready")} />
                  </Suspense>
                </Report>
              </Canvas>
              {preview === "loading" && <span className="muted">Loading preview…</span>}
            </div>
          )}
          <label>Display Name
            <input className="control" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Modern Chair" />
          </label>
          <label>Item Type
            <select className="control" value={type} onChange={(e) => setType(e.target.value)}>
              {ITEM_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <label>Thumbnail Image (optional)
            <input className="control" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setThumb(e.target.files?.[0] ?? null)} />
            <small className="muted">If not provided, the preview above is used.</small>
          </label>
          <label>Scale
            <select className="control" value={scale} onChange={(e) => setScale(e.target.value)}>
              {SCALES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <small className="muted">If the model appears too small or too large, try a different scale option.</small>
          </label>
        </form>
        {progress !== null && (
          <p><progress value={progress} /> {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Measuring…"}</p>
        )}
        {done && <p className="alert success" role="status"><strong>Success!</strong> {done}</p>}
        {error && <p className="alert danger" role="alert"><strong>Error:</strong> {error}</p>}
      </Modal>
    </>
  );
}

/** The model framed from the front-right, above: the thumbnail. */
function Preview({ url, onReady }: { url: string; onReady: () => void }) {
  const { scene } = useGLTF(url);
  const { camera, invalidate } = useThree();
  useEffect(() => () => useGLTF.clear(url), [url]);
  useLayoutEffect(() => {
    const box = new THREE.Box3().setFromObject(scene, true);
    const centre = box.getCenter(new THREE.Vector3());
    const d = box.getBoundingSphere(new THREE.Sphere()).radius / Math.sin(THREE.MathUtils.degToRad(22.5));
    camera.position.copy(centre).add(new THREE.Vector3(0.6, 0.5, 1).normalize().multiplyScalar(d));
    camera.near = d / 100;
    camera.far = d * 100;
    camera.lookAt(centre);
    camera.updateProjectionMatrix();
    invalidate();
    requestAnimationFrame(onReady); // after that frame is drawn
  }, [scene, camera]);
  return <primitive object={scene} />;
}

/** fetch has no upload progress; XHR does (old model-upload.js showed it). */
function post(url: string, body: FormData, onProgress: (fraction: number) => void) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let parsed = {};
      try { parsed = JSON.parse(x.responseText); } catch { /* not JSON: status says enough */ }
      resolve({ status: x.status, body: parsed });
    };
    x.onerror = () => reject(new Error("Could not reach the server"));
    x.send(body);
  });
}
