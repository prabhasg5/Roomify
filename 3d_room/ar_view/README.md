# Roomify AR Feature

This module allows you to view your 3D room designs in Augmented Reality on your mobile device.

## How It Works

1. **Design your room** in the 3D editor with furniture
2. **Export to AR** - The scene is converted to GLB format and uploaded to the AR server
3. **Scan QR code** or enter the URL on your mobile device
4. **View in AR** - Place your room design in the real world!

## Setup Instructions

### 1. Install Dependencies

```bash
cd 3d_room/ar_view
npm install
```

### 2. Generate SSL Certificates

AR requires HTTPS. Generate self-signed certificates:

```bash
# Generate certificates (valid for 365 days)
openssl req -nodes -new -x509 -keyout key.pem -out cert.pem -days 365 -subj '/CN=localhost'
```

### 3. Start the AR Server

```bash
npm start
```

The server will display:
- Local URL: `https://localhost:8002`
- Network URL: `https://YOUR_IP:8002` (use this on mobile)

### 4. Start the 3D Room Editor

In a separate terminal:
```bash
cd 3d_room/example
python3 -m http.server 8000
```

Or use any static file server.

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
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   3D Editor     │────▶│   AR Server     │────▶│  Mobile AR      │
│   (Desktop)     │     │   (Node.js)     │     │  (model-viewer) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
     Browser              HTTPS:8002              WebXR/ARCore
```

### Files

- `ar-server.js` - Express server handling GLB uploads and serving AR view
- `ar-view.html` - Mobile-friendly AR viewer using model-viewer
- `package.json` - Node.js dependencies

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
- Verify the AR server is running

### "Certificate error" on mobile
- This is expected with self-signed certificates
- Click "Advanced" → "Proceed anyway" (Chrome)
- On iOS Safari, tap "Show Details" → "visit this website"

### Models look different in AR
- The GLB export converts materials to standard PBR
- Some legacy materials may look slightly different
- Textures are preserved when possible

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/upload-model` | POST | Upload a GLB file |
| `/save-design` | POST | Save design JSON |
| `/current-design` | GET | Get latest design |
| `/list-models` | GET | List all uploaded models |
| `/models/:file` | GET | Serve model file |
| `/cleanup` | POST | Remove old models (keeps last 10) |

## Browser Compatibility

### AR Support:
- **Android**: Chrome 79+ with ARCore
- **iOS**: Safari 12+ with ARKit (Quick Look)
- **Desktop**: No AR, but 3D preview works

### 3D Editor:
- All modern browsers with WebGL support
