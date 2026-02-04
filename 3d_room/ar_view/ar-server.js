/**
 * AR Server for Roomify
 * Handles GLB model uploads and serves the AR view
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const cors = require('cors');
const os = require('os');

const app = express();

// Enable CORS for cross-origin requests
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use('/models', express.static(path.join(__dirname, 'models')));

// Serve GLB models from the example folder (for AR viewer to load actual 3D models)
app.use('/glb', express.static(path.join(__dirname, '../example/models/glb')));

// Serve JS models from the example folder (CORS-enabled for AR viewer)
app.use('/js-models', express.static(path.join(__dirname, '../example/models/js')));

// Serve Three.js from the example folder (CORS-enabled for AR viewer)
app.use('/three', express.static(path.join(__dirname, '../example/js')));

// Create models directory if it doesn't exist
const modelsDir = path.join(__dirname, 'models');
if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, modelsDir);
    },
    filename: function (req, file, cb) {
        // Use timestamp to create unique filenames
        const timestamp = Date.now();
        const filename = `room-design-${timestamp}.glb`;
        cb(null, filename);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    },
    fileFilter: function (req, file, cb) {
        // Accept GLB and GLTF files
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.glb' || ext === '.gltf') {
            cb(null, true);
        } else {
            cb(new Error('Only GLB and GLTF files are allowed'));
        }
    }
});

// Store the current design data (for JSON-based sharing)
let currentDesign = null;

// Upload GLB model endpoint
app.post('/upload-model', upload.single('model'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const modelUrl = `/models/${req.file.filename}`;
        const serverIP = getLocalIP();
        const port = process.env.PORT || 8002;
        const protocol = 'https';
        
        const fullModelUrl = `${protocol}://${serverIP}:${port}${modelUrl}`;
        const arUrl = `${protocol}://${serverIP}:${port}/ar-view.html?model=${encodeURIComponent(modelUrl)}`;

        console.log(`Model uploaded: ${req.file.filename}`);
        console.log(`AR View URL: ${arUrl}`);

        res.json({
            success: true,
            modelUrl: fullModelUrl,
            arUrl: arUrl,
            filename: req.file.filename
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Save design JSON endpoint
app.post('/save-design', (req, res) => {
    try {
        currentDesign = req.body;
        const timestamp = Date.now();
        const filename = `design-${timestamp}.json`;
        const filepath = path.join(modelsDir, filename);
        
        fs.writeFileSync(filepath, JSON.stringify(currentDesign, null, 2));
        
        const serverIP = getLocalIP();
        const port = process.env.PORT || 8002;
        const arUrl = `https://${serverIP}:${port}/ar-view.html?design=${filename}`;
        
        console.log(`Design saved: ${filename}`);
        
        res.json({
            success: true,
            designUrl: `/models/${filename}`,
            arUrl: arUrl
        });
    } catch (error) {
        console.error('Save design error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get current design endpoint
app.get('/current-design', (req, res) => {
    if (currentDesign) {
        res.json(currentDesign);
    } else {
        res.status(404).json({ error: 'No design saved' });
    }
});

// Get design by filename
app.get('/design/:filename', (req, res) => {
    const filepath = path.join(modelsDir, req.params.filename);
    if (fs.existsSync(filepath)) {
        const design = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        res.json(design);
    } else {
        res.status(404).json({ error: 'Design not found' });
    }
});

// List all uploaded models
app.get('/list-models', (req, res) => {
    try {
        const files = fs.readdirSync(modelsDir)
            .filter(f => f.endsWith('.glb'))
            .map(f => ({
                name: f,
                url: `/models/${f}`,
                created: fs.statSync(path.join(modelsDir, f)).birthtime
            }))
            .sort((a, b) => b.created - a.created);
        
        res.json({ success: true, models: files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Clean up old models (keep last 10)
app.post('/cleanup', (req, res) => {
    try {
        const files = fs.readdirSync(modelsDir)
            .filter(f => f.endsWith('.glb'))
            .map(f => ({
                name: f,
                path: path.join(modelsDir, f),
                created: fs.statSync(path.join(modelsDir, f)).birthtime
            }))
            .sort((a, b) => b.created - a.created);
        
        // Keep only the 10 most recent
        const toDelete = files.slice(10);
        toDelete.forEach(f => {
            fs.unlinkSync(f.path);
            console.log(`Deleted old model: ${f.name}`);
        });
        
        res.json({ success: true, deleted: toDelete.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get network info endpoint - returns current IP for dynamic QR codes
app.get('/network-info', (req, res) => {
    const ip = getLocalIP();
    res.json({
        ip: ip,
        httpPort: 8003,
        httpsPort: 8002,
        arUrl: `https://${ip}:8002/ar-mobile.html`,
        localUrl: 'http://localhost:8003/ar-mobile.html'
    });
});

// Get local IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Start server
const PORT = process.env.PORT || 8002;
const HTTP_PORT = 8003; // Additional HTTP port for local development

// Check for SSL certificates
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');

// Always start HTTP server for local development (avoids CORS/certificate issues)
http.createServer(app).listen(HTTP_PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log(`\nHTTP Server (for local dev): http://localhost:${HTTP_PORT}`);
});

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    // Start HTTPS server
    const httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
    
    https.createServer(httpsOptions, app).listen(PORT, '0.0.0.0', () => {
        const ip = getLocalIP();
        console.log('\n=================================');
        console.log('  Roomify AR Server Started');
        console.log('=================================');
        console.log(`\nHTTPS Server running on:`);
        console.log(`  Local:   https://localhost:${PORT}`);
        console.log(`  Network: https://${ip}:${PORT}`);
        console.log(`\nHTTP Server (local dev):`);
        console.log(`  Local:   http://localhost:${HTTP_PORT}`);
        console.log(`\nAR View URL: https://${ip}:${PORT}/ar-view.html`);
        console.log('\nMake sure your mobile device is on the same WiFi network.');
        console.log('=================================\n');
    });
} else {
    // Start HTTP server (development only)
    console.log('Warning: No SSL certificates found. Starting HTTP server.');
    console.log('For AR to work on mobile, you need HTTPS.');
    console.log('Generate certificates with: openssl req -nodes -new -x509 -keyout key.pem -out cert.pem');
    
    http.createServer(app).listen(PORT, '0.0.0.0', () => {
        const ip = getLocalIP();
        console.log(`HTTP Server running on http://${ip}:${PORT}`);
    });
}

module.exports = app;
