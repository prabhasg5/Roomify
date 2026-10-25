// The two modal flows from the old example.js mainControls: CAD import (cad-import-modal) and
// Export to AR (ar-modal). Native <dialog>s; the importers are the ESM copies in core/.

import { useRef, useState, type ReactNode } from "react";
import { CADImporter, type CadEntity, type CadHeader, type CadUnit } from "./core/cad-importer.js";
import { fromDesign, toDesign } from "./core/design";
import { DWGImporter } from "./core/dwg-importer.js";
import { useViewer } from "./store";

const STORAGE_KEY = "ar_room_design";

function Modal({ dialog, title, onClose, children, footer }: {
  dialog: React.RefObject<HTMLDialogElement | null>;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    // A click on the dialog element itself is a click on its backdrop (old .cad-modal-backdrop).
    <dialog ref={dialog} className="modal" onClose={onClose} onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}>
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
      <button className="info" onClick={() => input.current?.click()} title="Import a DXF or DWG CAD file as floorplan">Import CAD</button>
      {notice && <span className="notice" role="status">{notice}</span>}
      <Modal
        dialog={dialog} title="Import CAD File" onClose={reset}
        footer={<>
          <button onClick={() => dialog.current?.close()}>Cancel</button>
          <button className="success" disabled={!parsed} onClick={importPlan}>Import Floorplan</button>
        </>}
      >
        {fileName && <p className="alert info"><strong>File:</strong> {fileName}</p>}
        {summary && (
          <>
            <fieldset>
              <legend>{fileName.toLowerCase().endsWith(".dwg") ? "DWG" : "DXF"} File Summary</legend>
              <p><strong>Total entities:</strong> {summary.totalEntities}</p>
              <p><strong>Entity types:</strong> {Object.entries(summary.entityTypes).map(([t, n]) => `${t} (${n})`).join(", ")}</p>
            </fieldset>
            {summary.layers.length > 0 && (
              <fieldset className="layers">
                <legend>Layers Found</legend>
                {summary.layers.map((l) => (
                  <div key={l.name}>
                    <strong>{l.name}</strong> <span className="badge">{l.entityCount} entities</span><br />
                    <small className="muted">{l.entityTypes}</small>
                  </div>
                ))}
              </fieldset>
            )}
          </>
        )}
        <fieldset>
          <legend>Import Settings</legend>
          <label>Source units in CAD file:{" "}
            <select value={unit} onChange={(e) => setUnit(e.target.value as CadUnit)}>
              {UNITS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <label>Layer filter (leave empty for all layers):{" "}
            <input value={layers} onChange={(e) => setLayers(e.target.value)} placeholder="e.g. A-WALL, WALL" />
          </label>
          <small className="muted">Comma-separated layer names. Only entities on these layers will be imported. Wall layers are auto-filled when detected.</small>
          <label><input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} /> <strong>Collapse double-line walls</strong> (recommended for architectural plans)</label>
          <small className="muted">Merges the two parallel lines of each wall into a single centerline. Turn off for plans drawn with single-line walls.</small>
        </fieldset>
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
export function ArExport() {
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
      <button className="success" onClick={exportToAR}>Export to AR</button>
      <Modal dialog={dialog} title="View in AR" onClose={() => setState(null)}>
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
              <input readOnly value={state.mobileUrl} onFocus={(e) => e.target.select()} aria-label="AR URL" />
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
