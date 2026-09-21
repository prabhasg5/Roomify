# Roomify AR Feature

This module allows you to view your 3D room designs in Augmented Reality on your mobile device.

**This directory has no server of its own.** The pages here are served by the FastAPI
backend (`backend/main.py`) over HTTPS, on the certificate checked in beside them.

## How It Works

1. **Design your room** in the 3D editor with furniture
2. **Export to AR** — the design is POSTed to `/api/designs` and written into `models/`
3. **Scan QR code** or enter the URL on your mobile device
4. **View in AR** — `ar-mobile.html` fetches `/current-design` same-origin, loads each
   item's GLB from `/glb`, and places it with WebXR hit-testing

## Setup Instructions

### 1. Start the servers

```bash
cd 3d_room
npm run dev          # tsc + Express :9000 + FastAPI :8080 + AR https :8002 + Vite :5173
```

`npm run ar` alone is the AR half: `uvicorn main:app --host 0.0.0.0 --port 8002
--ssl-keyfile key.pem --ssl-certfile cert.pem`. uvicorn serves one protocol per process, so
:8080 (plain HTTP, desktop and the Vite proxy) and :8002 (HTTPS, the phone) are two
processes over the same app.

- Mobile: `https://YOUR_IP:8002/ar-mobile.html` — the QR code carries this
- Desktop: `http://localhost:8080/ar-mobile.html` — same pages, no certificate warning

### 2. Certificates

`cert.pem` / `key.pem` are checked in and valid to **Feb 2035** — nothing to do. To
regenerate:

```bash
openssl req -nodes -new -x509 -keyout key.pem -out cert.pem -days 3650 -subj '/CN=localhost'
```

`ar_view/` is served whole, so the server 404s `/key.pem` and `/cert.pem` by name — but a
private key in a repo is still a private key: regenerate it if this ever leaves a LAN.

## Using AR

### From the 3D Editor:

1. Design your room by adding furniture from the "Add Items" tab
2. Click **"Export to AR"** button
3. A modal will appear with:
   - QR code to scan
   - Direct URL to copy
4. On your mobile device:
   - Connect to the same WiFi network
   - Scan the QR code or enter the URL
   - Accept the security warning (self-signed certificate)
   - Tap "View in AR"
   - Point at a flat surface and tap to place!

### Alternative: Download GLB

Click **"Download GLB"** to save the room design as a GLB file. You can then:
- View it in any GLB viewer
- Upload to other AR platforms
- Share the file directly

## Technical Details

### Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   3D Editor     │────▶│  backend/main.py │────▶│  Mobile AR      │
│   (Desktop)     │ POST│    (FastAPI)     │ GET │  (WebXR)        │
└─────────────────┘     └──────────────────┘     └─────────────────┘
   Vite :5173            :8080 http           https :8002
   /api/designs          :8002 https          /ar-mobile.html
                         designs land in ar_view/models/
```

The phone fetches everything **same-origin over HTTPS** — that is why these endpoints could
not sit behind the Vite dev proxy, and why serving these pages had to move to Python for the
design endpoints to follow.

### Files

- `ar-mobile.html` — the real AR viewer: WebXR `immersive-ar` + hit-testing
- `ar-view.html` — model-viewer fallback viewer
- `models/` — saved designs (`design-<ms>.json`) and uploaded GLBs
- `cert.pem` / `key.pem` — the TLS keypair uvicorn is started with

### Client-side

- `js/ar-exporter.js` - Exports Three.js scene to GLB format

## Troubleshooting

### "AR not available" on mobile
- Make sure you're using Chrome on Android or Safari on iOS
- ARCore/ARKit needs to be installed
- Camera permission must be granted

### "Connection refused" error
- Make sure mobile and computer are on the same WiFi
- Check firewall settings (port 8002 must be open)
- Verify `npm run ar` (or `npm run dev`) is running, and that the IP in the QR code is the
  one `curl localhost:8080/api/network-info` reports

### "Certificate error" on mobile
- This is expected with self-signed certificates
- Click "Advanced" → "Proceed anyway" (Chrome)
- On iOS Safari, tap "Show Details" → "visit this website"

### Models look different in AR
- The GLB export converts materials to standard PBR
- Some legacy materials may look slightly different
- Textures are preserved when possible

## API Endpoints

> All of these are served by `backend/main.py` — see
> [BACKEND_REWRITE_CONTEXT](../BACKEND_REWRITE_CONTEXT.md). The paths are unchanged from the
> Express server they replaced, because the AR pages were not rewritten.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/designs` | POST | Save a design (the editor; validated, written to `models/`) |
| `/current-design` | GET | Latest design — the newest `design-*.json` in `models/` |
| `/design/:file` | GET | One design by name |
| `/upload-model` | POST | Upload a GLB file (100MB max, `.glb`/`.gltf` only) |
| `/list-models` | GET | List uploaded models, newest first |
| `/cleanup` | POST | Remove old models (keeps last 10) |
| `/api/network-info` | GET | LAN IP + ports for the QR code |
| `/models` `/glb` `/js-models` `/three` | GET | Static: designs + uploads, and the workspace's own GLB / Three.js JSON / script folders, so both views read the same files |

## Browser Compatibility

### AR Support:
- **Android**: Chrome 79+ with ARCore
- **iOS**: Safari 12+ with ARKit (Quick Look)
- **Desktop**: No AR, but 3D preview works

### 3D Editor:
- All modern browsers with WebGL support
