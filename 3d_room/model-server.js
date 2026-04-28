/**
 * Model Upload Server
 * 
 * Serves the Blueprint3D app and provides an API endpoint
 * to upload GLTF/GLB files, convert them to Three.js JSON v3.1,
 * and register them in the items catalog.
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { convertGltfToThreejsJson } = require('./gltf-to-threejs-json');

const app = express();
const PORT = process.env.PORT || 9000;

// Directories
const EXAMPLE_DIR = path.join(__dirname, 'example');
const MODELS_JS_DIR = path.join(EXAMPLE_DIR, 'models', 'js');
const THUMBNAILS_DIR = path.join(EXAMPLE_DIR, 'models', 'thumbnails');
const GLB_DIR = path.join(EXAMPLE_DIR, 'models', 'glb');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure directories exist
[UPLOADS_DIR, MODELS_JS_DIR, THUMBNAILS_DIR, GLB_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Catalog file tracks user-uploaded models
const CATALOG_FILE = path.join(EXAMPLE_DIR, 'models', 'user-models.json');
function loadCatalog() {
  if (fs.existsSync(CATALOG_FILE)) {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8'));
  }
  return [];
}
function saveCatalog(catalog) {
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from example directory
app.use(express.static(EXAMPLE_DIR));

// Configure multer for file uploads
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    // Only validate the model field — allow any image for thumbnail
    if (file.fieldname === 'model') {
      const ext = path.extname(file.originalname).toLowerCase();
      if (['.glb', '.gltf'].includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Only .glb and .gltf files are allowed for the model'));
      }
    } else {
      // thumbnail or other fields — accept
      cb(null, true);
    }
  }
});

/**
 * POST /api/upload-model
 * 
 * Upload a GLTF/GLB file, convert to Three.js JSON format,
 * and add to the items catalog.
 * 
 * Form fields:
 *   - model: the GLTF/GLB file (required)
 *   - name: display name for the item (required)
 *   - type: item type - 1=floor, 2=wall, 3=in-wall, 7=in-wall-floor, 8=on-floor (default: 1)
 *   - thumbnail: optional thumbnail image
 */
app.post('/api/upload-model', (req, res) => {
  const uploadMiddleware = upload.fields([
    { name: 'model', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
    { name: 'texture', maxCount: 1 }
  ]);

  uploadMiddleware(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err.message);
      return res.status(400).json({ error: err.message });
    }

    try {
      if (!req.files || !req.files.model || req.files.model.length === 0) {
        return res.status(400).json({ error: 'No model file uploaded' });
      }

    const modelFile = req.files.model[0];
    const displayName = req.body.name || path.basename(modelFile.originalname, path.extname(modelFile.originalname));
    const itemType = req.body.type || '1';
    const scaleFactor = req.body.scaleFactor || 'auto';

    // Sanitize model name
    const safeName = displayName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const timestamp = Date.now();
    const uniqueName = `${safeName}-${timestamp}`;

    // Check for optional texture file
    const textureFile = (req.files.texture && req.files.texture.length > 0)
      ? req.files.texture[0] : null;

    console.log(`\n📦 Converting: ${modelFile.originalname} → ${uniqueName}`);
    if (textureFile) console.log(`   With texture: ${textureFile.originalname}`);

    // Convert GLTF/GLB → Three.js JSON
    const result = await convertGltfToThreejsJson(
      modelFile.path,
      MODELS_JS_DIR,
      uniqueName,
      {
        maxFaces: 15000,
        textureSize: 1024,
        generateThumbnail: true,
        scaleFactor: scaleFactor,
        externalTexturePath: textureFile ? textureFile.path : null
      }
    );

    // Keep a GLB/GLTF copy that AR can load directly
    const ext = path.extname(modelFile.originalname).toLowerCase() || '.glb';
    const glbFileName = `${uniqueName}${ext}`;
    const glbDest = path.join(GLB_DIR, glbFileName);
    fs.copyFileSync(modelFile.path, glbDest);

    // Move thumbnail to the thumbnails directory
    let thumbnailFile;
    if (req.files.thumbnail && req.files.thumbnail.length > 0) {
      // User provided a custom thumbnail
      const customThumb = req.files.thumbnail[0];
      thumbnailFile = `thumbnail_${uniqueName}.png`;
      const thumbDest = path.join(THUMBNAILS_DIR, thumbnailFile);
      const sharp = require('sharp');
      await sharp(customThumb.path)
        .resize(256, 256, { fit: 'cover' })
        .png()
        .toFile(thumbDest);
      // Clean up
      fs.unlinkSync(customThumb.path);
    } else if (result.thumbnailPath) {
      // Use auto-generated thumbnail
      thumbnailFile = `thumbnail_${uniqueName}.png`;
      const thumbDest = path.join(THUMBNAILS_DIR, thumbnailFile);
      if (result.thumbnailPath !== thumbDest) {
        fs.copyFileSync(result.thumbnailPath, thumbDest);
        // Remove from js dir if it was generated there
        if (fs.existsSync(result.thumbnailPath) && result.thumbnailPath !== thumbDest) {
          fs.unlinkSync(result.thumbnailPath);
        }
      }
    }

    // Build the item entry
    const itemEntry = {
      name: displayName,
      image: `models/thumbnails/${thumbnailFile}`,
      model: `models/js/${result.modelFile}`,
      glb: `models/glb/${glbFileName}`,
      type: itemType,
      addedAt: new Date().toISOString(),
      metadata: result.metadata
    };

    // Add to catalog
    const catalog = loadCatalog();
    catalog.push(itemEntry);
    saveCatalog(catalog);

    // Keep a copy of uploaded GLB for debugging, clean the multer temp
    const keepDir = path.join(__dirname, 'uploads-debug');
    if (!fs.existsSync(keepDir)) fs.mkdirSync(keepDir, { recursive: true });
    fs.copyFileSync(modelFile.path, path.join(keepDir, modelFile.originalname || 'model.glb'));
    fs.unlinkSync(modelFile.path);
    if (textureFile && fs.existsSync(textureFile.path)) fs.unlinkSync(textureFile.path);

    console.log(`✅ Added: "${displayName}" (type: ${itemType})`);

    res.json({
      success: true,
      item: itemEntry,
      message: `Model "${displayName}" converted and added successfully`
    });

  } catch (err) {
    console.error('❌ Upload failed:', err);
    // Clean up on error
    if (req.files) {
      Object.values(req.files).flat().forEach(f => {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
      });
    }
    res.status(500).json({ error: err.message });
  }
  });
});

/**
 * GET /api/models
 * Returns the list of user-uploaded models
 */
app.get('/api/models', (req, res) => {
  const catalog = loadCatalog();
  res.json(catalog);
});

/**
 * DELETE /api/models/:name
 * Remove a user-uploaded model
 */
app.delete('/api/models/:name', (req, res) => {
  const catalog = loadCatalog();
  const idx = catalog.findIndex(m => m.name === req.params.name);
  if (idx === -1) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const item = catalog[idx];

  // Delete files
  const jsPath = path.join(EXAMPLE_DIR, item.model);
  const imgPath = path.join(EXAMPLE_DIR, item.image);
  const texturePath = jsPath.replace('.js', '.png');
  const glbPath = item.glb ? path.join(EXAMPLE_DIR, item.glb) : null;

  [jsPath, imgPath, texturePath, glbPath].forEach(p => {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  });

  catalog.splice(idx, 1);
  saveCatalog(catalog);

  res.json({ success: true, message: `Deleted "${item.name}"` });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🏠 Roomify server running at http://localhost:${PORT}`);
  console.log(`   Upload models via the UI or POST to /api/upload-model`);
  console.log(`   Models directory: ${MODELS_JS_DIR}\n`);
});
