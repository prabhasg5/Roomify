/**
 * GLTF/GLB → Three.js JSON v3.1 Converter
 * 
 * Converts uploaded GLTF/GLB models to the legacy Three.js JSON format
 * used by Blueprint3D (THREE.JSONLoader in Three.js r69).
 *
 * Supports:
 *   - Multiple materials (per-primitive material indices)
 *   - External texture PNG (uploaded separately or extracted from GLB)
 *   - Auto-UV generation when missing
 *   - Auto-normal generation when missing
 *   - Auto-scaling (meters → centimeters)
 *   - Scene graph flattening (bakes node transforms)
 * 
 * Output: {model_name}_baked.js + {model_name}_baked.png
 */

const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { dedup, weld, simplify, flatten } = require('@gltf-transform/functions');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

/**
 * Convert a GLTF/GLB file to the Three.js JSON v3.1 format.
 * 
 * @param {string} inputPath - Path to the .gltf or .glb file
 * @param {string} outputDir - Directory to write the .js and .png files
 * @param {string} modelName - Name for the output files (e.g. "my-chair")
 * @param {object} options - Optional settings
 * @returns {object} { jsPath, texturePath, thumbnailPath, metadata }
 */
async function convertGltfToThreejsJson(inputPath, outputDir, modelName, options = {}) {
  const {
    maxFaces = 15000,
    textureSize = 1024,
    generateThumbnail = true,
    scaleFactor = 'auto',
    externalTexturePath = null   // Path to a user-uploaded texture PNG/JPG
  } = options;

  const safeName = modelName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // ─── Read and flatten the GLTF/GLB ───
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(inputPath);
  await document.transform(flatten());
  console.log('   Flattened scene graph');

  const root = document.getRoot();

  // ─── Build a material registry ───
  // Map each GLTF material to a Three.js material index
  const gltfMaterials = root.listMaterials();
  const materialMap = new Map(); // gltf material → index
  const materialColors = [];     // [{r,g,b, metallic, roughness, name}]
  let firstTextureBuffer = null; // First embedded texture found

  for (let mi = 0; mi < gltfMaterials.length; mi++) {
    const mat = gltfMaterials[mi];
    materialMap.set(mat, mi);

    const bcf = mat.getBaseColorFactor();
    const tex = mat.getBaseColorTexture();
    if (tex && !firstTextureBuffer) {
      firstTextureBuffer = tex.getImage();
    }

    materialColors.push({
      r: bcf[0], g: bcf[1], b: bcf[2],
      metallic: mat.getMetallicFactor(),
      roughness: mat.getRoughnessFactor(),
      name: mat.getName() || `material_${mi}`
    });
  }

  // If no materials at all, add a default
  if (gltfMaterials.length === 0) {
    materialColors.push({
      r: 0.6, g: 0.6, b: 0.6,
      metallic: 0, roughness: 0.5,
      name: 'default'
    });
  }

  console.log(`   Materials: ${materialColors.length} (${materialColors.map(m => m.name).join(', ')})`);

  // ─── Collect geometry from all nodes ───
  const allVertices = [];
  const allNormals = [];
  const allUvs = [];
  const allFaces = [];
  const normalMap = new Map();
  const uvMap = new Map();
  let vertexOffset = 0;

  const nodes = root.listNodes();

  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh) continue;

    for (const primitive of mesh.listPrimitives()) {
      const positionAccessor = primitive.getAttribute('POSITION');
      if (!positionAccessor) continue;

      const positions = positionAccessor.getArray();
      const posCount = positionAccessor.getCount();

      // ── Indices ──
      const indexAccessor = primitive.getIndices();
      const indices = indexAccessor ? indexAccessor.getArray() : null;

      // ── Normals (auto-generate if missing) ──
      const normalAccessor = primitive.getAttribute('NORMAL');
      let normals = normalAccessor ? normalAccessor.getArray() : null;

      if (!normals) {
        normals = generateNormals(positions, posCount, indices);
        console.log(`   Auto-generated ${posCount} normals`);
      }

      // ── UVs (auto-generate if missing) ──
      const uvAccessor = primitive.getAttribute('TEXCOORD_0');
      let uvs = uvAccessor ? uvAccessor.getArray() : null;

      if (!uvs) {
        uvs = generateBoxProjectedUVs(positions, posCount);
        console.log(`   Auto-generated ${posCount} UVs (box projection)`);
      }

      // ── Material index ──
      const primMaterial = primitive.getMaterial();
      let materialIndex = 0;
      if (primMaterial && materialMap.has(primMaterial)) {
        materialIndex = materialMap.get(primMaterial);
      }

      // ── Add vertices ──
      for (let i = 0; i < posCount; i++) {
        allVertices.push(
          roundTo(positions[i * 3], 4),
          roundTo(positions[i * 3 + 1], 4),
          roundTo(positions[i * 3 + 2], 4)
        );
      }

      // ── Build faces ──
      const triCount = indices ? indices.length / 3 : posCount / 3;

      for (let t = 0; t < triCount; t++) {
        const i0 = indices ? indices[t * 3] : t * 3;
        const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
        const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

        const ni0 = getNormalIndex(normals, i0, normalMap, allNormals);
        const ni1 = getNormalIndex(normals, i1, normalMap, allNormals);
        const ni2 = getNormalIndex(normals, i2, normalMap, allNormals);

        const ui0 = getUvIndex(uvs, i0, uvMap, allUvs);
        const ui1 = getUvIndex(uvs, i1, uvMap, allUvs);
        const ui2 = getUvIndex(uvs, i2, uvMap, allUvs);

        // Face type 42 = triangle(0) + material(2) + vertexUV(8) + vertexNormal(32)
        allFaces.push(42);
        allFaces.push(i0 + vertexOffset, i1 + vertexOffset, i2 + vertexOffset);
        allFaces.push(materialIndex);
        allFaces.push(ui0, ui1, ui2);
        allFaces.push(ni0, ni1, ni2);
      }

      vertexOffset += posCount;
    }
  }

  // ─── Auto-scale ───
  const bbox = computeBBox(allVertices);
  const autoScale = computeAutoScale(bbox, scaleFactor);

  if (autoScale !== 1) {
    for (let i = 0; i < allVertices.length; i++) {
      allVertices[i] = roundTo(allVertices[i] * autoScale, 4);
    }
    console.log(`   Scaled: ${(bbox.rangeX * autoScale).toFixed(1)} × ${(bbox.rangeY * autoScale).toFixed(1)} × ${(bbox.rangeZ * autoScale).toFixed(1)}`);
  }

  // ─── Handle textures ───
  const textureName = `${safeName}_baked.png`;
  const texturePath = path.join(outputDir, textureName);

  // Priority: external texture > embedded texture > generated multi-color texture
  if (externalTexturePath && fs.existsSync(externalTexturePath)) {
    // User uploaded a separate texture file
    await sharp(externalTexturePath)
      .resize(textureSize, textureSize, { fit: 'inside' })
      .png()
      .toFile(texturePath);
    console.log('   Using external texture:', externalTexturePath);
  } else if (firstTextureBuffer) {
    await sharp(Buffer.from(firstTextureBuffer))
      .resize(textureSize, textureSize, { fit: 'inside' })
      .png()
      .toFile(texturePath);
    console.log('   Using embedded texture from GLB');
  } else {
    // No texture — create a multi-color strip texture (one color per material)
    await generateMaterialTexture(materialColors, texturePath);
    console.log('   Generated multi-material color texture');
  }

  // ─── Generate thumbnail ───
  let thumbnailPath = null;
  if (generateThumbnail) {
    thumbnailPath = path.join(outputDir, `thumbnail_${safeName}.png`);
    if (externalTexturePath && fs.existsSync(externalTexturePath)) {
      await sharp(externalTexturePath)
        .resize(256, 256, { fit: 'cover' })
        .png()
        .toFile(thumbnailPath);
    } else if (firstTextureBuffer) {
      await sharp(Buffer.from(firstTextureBuffer))
        .resize(256, 256, { fit: 'cover' })
        .png()
        .toFile(thumbnailPath);
    } else {
      await generateThumbnailFromColors(materialColors, safeName, thumbnailPath);
    }
  }

  // ─── Build Three.js materials array ───
  const threeMaterials = materialColors.map((mc, i) => {
    // Brighten very dark colors
    let cr = mc.r, cg = mc.g, cb = mc.b;
    const brightness = (cr + cg + cb) / 3;
    if (brightness < 0.06) {
      const maxC = Math.max(cr, cg, cb, 0.005);
      const scale = 0.47 / maxC; // target ~47% brightness
      cr = Math.min(1, cr * scale);
      cg = Math.min(1, cg * scale);
      cb = Math.min(1, cb * scale);
      console.log(`   Material "${mc.name}" was very dark, brightened`);
    }

    return {
      DbgColor: 15658734,
      DbgIndex: i,
      DbgName: mc.name,
      blending: "NormalBlending",
      colorAmbient: [1.0, 1.0, 1.0],
      colorDiffuse: [cr, cg, cb],
      colorEmissive: [0.0, 0.0, 0.0],
      colorSpecular: mc.metallic > 0.5 ? [0.8, 0.8, 0.8] : [0.3, 0.3, 0.3],
      depthTest: true,
      depthWrite: true,
      mapDiffuse: textureName,
      mapDiffuseWrap: ["repeat", "repeat"],
      shading: mc.metallic > 0.5 ? "Phong" : "Lambert",
      specularCoef: mc.metallic > 0.5 ? 80 : 30,
      transparency: 1.0,
      transparent: false,
      vertexColors: false,
      doubleSided: true
    };
  });

  // ─── Count faces ───
  const faceCount = countFaces(allFaces);

  // ─── Build the output JSON ───
  const output = {
    metadata: {
      formatVersion: 3.1,
      generatedBy: "Roomify GLTF Converter",
      vertices: allVertices.length / 3,
      faces: faceCount,
      normals: allNormals.length / 3,
      colors: 0,
      uvs: [allUvs.length / 2],
      materials: threeMaterials.length,
      morphTargets: 0,
      bones: 0
    },
    scale: 1.0,
    materials: threeMaterials,
    vertices: allVertices,
    morphTargets: [],
    normals: allNormals,
    colors: [],
    uvs: [allUvs],
    faces: allFaces,
    bones: [],
    skinIndices: [],
    skinWeights: [],
    animations: []
  };

  // ─── Write output ───
  const jsPath = path.join(outputDir, `${safeName}_baked.js`);
  fs.writeFileSync(jsPath, JSON.stringify(output, null, '\t'));

  const result = {
    jsPath,
    texturePath,
    thumbnailPath,
    modelFile: `${safeName}_baked.js`,
    textureFile: textureName,
    thumbnailFile: thumbnailPath ? `thumbnail_${safeName}.png` : null,
    metadata: {
      name: safeName,
      vertices: allVertices.length / 3,
      faces: faceCount,
      normals: allNormals.length / 3,
      uvs: allUvs.length / 2,
      materials: threeMaterials.length
    }
  };

  console.log(`✅ Converted: ${inputPath}`);
  console.log(`   ${result.metadata.vertices} verts, ${faceCount} faces, ${threeMaterials.length} materials`);

  return result;
}

// ─── Helper Functions ───

function roundTo(num, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(num * factor) / factor;
}

function getNormalIndex(normals, vertexIndex, normalMap, allNormals) {
  if (!normals) return 0;
  const nx = roundTo(normals[vertexIndex * 3], 6);
  const ny = roundTo(normals[vertexIndex * 3 + 1], 6);
  const nz = roundTo(normals[vertexIndex * 3 + 2], 6);
  const key = `${nx},${ny},${nz}`;
  if (normalMap.has(key)) return normalMap.get(key);
  const idx = allNormals.length / 3;
  allNormals.push(nx, ny, nz);
  normalMap.set(key, idx);
  return idx;
}

function getUvIndex(uvs, vertexIndex, uvMap, allUvs) {
  if (!uvs) return 0;
  const u = roundTo(uvs[vertexIndex * 2], 6);
  const v = roundTo(uvs[vertexIndex * 2 + 1], 6);
  const key = `${u},${v}`;
  if (uvMap.has(key)) return uvMap.get(key);
  const idx = allUvs.length / 2;
  allUvs.push(u, v);
  uvMap.set(key, idx);
  return idx;
}

function generateNormals(positions, posCount, indices) {
  const normals = new Float32Array(posCount * 3);
  const triCount = indices ? indices.length / 3 : posCount / 3;
  for (let t = 0; t < triCount; t++) {
    const a = indices ? indices[t * 3] : t * 3;
    const b = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const c = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const ax = positions[a*3], ay = positions[a*3+1], az = positions[a*3+2];
    const bx = positions[b*3], by = positions[b*3+1], bz = positions[b*3+2];
    const cx = positions[c*3], cy = positions[c*3+1], cz = positions[c*3+2];
    const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
    const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
    const nx = e1y*e2z - e1z*e2y;
    const ny = e1z*e2x - e1x*e2z;
    const nz = e1x*e2y - e1y*e2x;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    const nnx = nx/len, nny = ny/len, nnz = nz/len;
    normals[a*3] += nnx; normals[a*3+1] += nny; normals[a*3+2] += nnz;
    normals[b*3] += nnx; normals[b*3+1] += nny; normals[b*3+2] += nnz;
    normals[c*3] += nnx; normals[c*3+1] += nny; normals[c*3+2] += nnz;
  }
  for (let i = 0; i < posCount; i++) {
    const x = normals[i*3], y = normals[i*3+1], z = normals[i*3+2];
    const len = Math.sqrt(x*x + y*y + z*z) || 1;
    normals[i*3] /= len; normals[i*3+1] /= len; normals[i*3+2] /= len;
  }
  return normals;
}

function generateBoxProjectedUVs(positions, posCount) {
  let lMinX=Infinity, lMaxX=-Infinity, lMinZ=Infinity, lMaxZ=-Infinity;
  for (let i = 0; i < posCount; i++) {
    lMinX = Math.min(lMinX, positions[i*3]); lMaxX = Math.max(lMaxX, positions[i*3]);
    lMinZ = Math.min(lMinZ, positions[i*3+2]); lMaxZ = Math.max(lMaxZ, positions[i*3+2]);
  }
  const rangeX = (lMaxX - lMinX) || 1;
  const rangeZ = (lMaxZ - lMinZ) || 1;
  const uvs = new Float32Array(posCount * 2);
  for (let i = 0; i < posCount; i++) {
    uvs[i*2]   = (positions[i*3]   - lMinX) / rangeX;
    uvs[i*2+1] = (positions[i*3+2] - lMinZ) / rangeZ;
  }
  return uvs;
}

function computeBBox(vertices) {
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, minZ=Infinity, maxZ=-Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    minX = Math.min(minX, vertices[i]); maxX = Math.max(maxX, vertices[i]);
    minY = Math.min(minY, vertices[i+1]); maxY = Math.max(maxY, vertices[i+1]);
    minZ = Math.min(minZ, vertices[i+2]); maxZ = Math.max(maxZ, vertices[i+2]);
  }
  return {
    minX, maxX, minY, maxY, minZ, maxZ,
    rangeX: maxX - minX, rangeY: maxY - minY, rangeZ: maxZ - minZ,
    maxDim: Math.max(maxX - minX, maxY - minY, maxZ - minZ)
  };
}

function computeAutoScale(bbox, scaleFactor) {
  if (scaleFactor !== 'auto') {
    const s = Number(scaleFactor) || 1;
    console.log(`   Manual scale: ×${s}`);
    return s;
  }

  const { rangeY, maxDim } = bbox;
  const height = rangeY > 0.001 ? rangeY : maxDim;
  const isFlat = height < maxDim * 0.1;

  if (height < 3) {
    if (isFlat && maxDim >= 30) {
      console.log(`   Auto-scale: flat cm object, ×1`);
      return 1;
    }
    console.log(`   Auto-scale: meters detected (h=${height.toFixed(3)}), ×100`);
    return 100;
  } else if (height < 25 && maxDim < 30) {
    console.log(`   Auto-scale: small units (h=${height.toFixed(2)}), ×10`);
    return 10;
  }
  console.log(`   Auto-scale: already cm (h=${height.toFixed(2)}), ×1`);
  return 1;
}

function countFaces(facesArray) {
  let count = 0, fi = 0;
  while (fi < facesArray.length) {
    const type = facesArray[fi];
    const isQuad = type & 1;
    fi++; // type
    fi += isQuad ? 4 : 3;
    if (type & 2) fi++;    // material
    if (type & 4) fi++;    // faceUV
    if (type & 8) fi += isQuad ? 4 : 3;   // vertexUV
    if (type & 16) fi++;   // faceNormal
    if (type & 32) fi += isQuad ? 4 : 3;  // vertexNormal
    if (type & 64) fi++;   // faceColor
    if (type & 128) fi += isQuad ? 4 : 3; // vertexColor
    count++;
  }
  return count;
}

/**
 * Generate a texture image with horizontal bands for each material color.
 * This gives each material a distinct visible color in the UV-mapped model.
 */
async function generateMaterialTexture(materialColors, outputPath) {
  const size = 256;
  const bandHeight = Math.max(1, Math.floor(size / materialColors.length));

  // Build SVG with horizontal color bands
  let rects = '';
  for (let i = 0; i < materialColors.length; i++) {
    const mc = materialColors[i];
    let r = Math.round(mc.r * 255);
    let g = Math.round(mc.g * 255);
    let b = Math.round(mc.b * 255);

    // Brighten very dark colors
    const brightness = (r + g + b) / 3;
    if (brightness < 30) {
      const maxC = Math.max(r, g, b, 1);
      const scale = 120 / maxC;
      r = Math.min(255, Math.round(r * scale));
      g = Math.min(255, Math.round(g * scale));
      b = Math.min(255, Math.round(b * scale));
    }

    // Handle metallic materials (silvery look)
    if (mc.metallic > 0.5 && brightness > 200) {
      r = 200; g = 200; b = 210; // silver
    }

    const y = i * bandHeight;
    rects += `<rect x="0" y="${y}" width="${size}" height="${bandHeight}" fill="rgb(${r},${g},${b})"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${rects}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function generateThumbnailFromColors(materialColors, safeName, outputPath) {
  // Primary color = most common material (first one)
  const mc = materialColors[0];
  let r = Math.round(mc.r * 255);
  let g = Math.round(mc.g * 255);
  let b = Math.round(mc.b * 255);
  const brightness = (r + g + b) / 3;
  if (brightness < 30) {
    const maxC = Math.max(r, g, b, 1);
    const scale = 120 / maxC;
    r = Math.min(255, Math.round(r * scale));
    g = Math.min(255, Math.round(g * scale));
    b = Math.min(255, Math.round(b * scale));
  }

  const svg = `
    <svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
      <rect width="256" height="256" fill="rgb(${r},${g},${b})" rx="8"/>
      <text x="128" y="128" text-anchor="middle" dominant-baseline="middle" 
            fill="white" font-family="sans-serif" font-size="14" font-weight="bold"
            stroke="black" stroke-width="0.5">${safeName}</text>
      <rect x="4" y="4" width="248" height="248" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="2" rx="6"/>
    </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

// ─── CLI usage ───
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: node gltf-to-threejs-json.js <input.glb> <outputDir> <modelName> [texturePath]');
    process.exit(1);
  }
  const opts = {};
  if (args[3]) opts.externalTexturePath = args[3];
  convertGltfToThreejsJson(args[0], args[1], args[2], opts)
    .then(result => {
      console.log('\nDone!');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('Conversion failed:', err);
      process.exit(1);
    });
}

module.exports = { convertGltfToThreejsJson };
