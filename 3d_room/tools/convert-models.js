/**
 * Model Converter - Converts Three.js JSON format models to GLB (GLTF Binary)
 * 
 * This script reads the old Three.js JSON format models and converts them
 * to modern GLB format that can be used in AR viewers, Unity, Blender, etc.
 * 
 * Usage: node convert-models.js
 */

const fs = require('fs');
const path = require('path');

// We need to install these packages
// npm install three @gltf-transform/core @gltf-transform/extensions

async function convertModels() {
    const modelsDir = path.join(__dirname, '../example/models/js');
    const outputDir = path.join(__dirname, '../example/models/glb');
    
    // Create output directory
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Get all JS model files
    const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.js'));
    
    console.log(`Found ${files.length} model files to convert\n`);
    
    for (const file of files) {
        const inputPath = path.join(modelsDir, file);
        const outputName = file.replace('.js', '.glb');
        const outputPath = path.join(outputDir, outputName);
        
        console.log(`Converting: ${file} -> ${outputName}`);
        
        try {
            // Read the JSON model file
            const content = fs.readFileSync(inputPath, 'utf8');
            const modelData = JSON.parse(content);
            
            // Convert to GLTF structure
            const gltf = convertThreeJsJsonToGltf(modelData, file);
            
            // Save as GLB
            const glb = createGlb(gltf);
            fs.writeFileSync(outputPath, glb);
            
            console.log(`  ✓ Converted successfully`);
        } catch (error) {
            console.log(`  ✗ Error: ${error.message}`);
        }
    }
    
    console.log(`\nConversion complete! GLB files saved to: ${outputDir}`);
}

/**
 * Convert Three.js JSON format to GLTF structure
 */
function convertThreeJsJsonToGltf(modelData, fileName) {
    const scale = modelData.scale || 1;
    const vertices = modelData.vertices || [];
    const normals = modelData.normals || [];
    const uvs = modelData.uvs && modelData.uvs[0] ? modelData.uvs[0] : [];
    const faces = modelData.faces || [];
    const materials = modelData.materials || [];
    
    // Parse faces - Three.js JSON format encodes face type in first value
    const positions = [];
    const normalData = [];
    const uvData = [];
    const indices = [];
    
    // Build vertex buffer from faces
    let vertexIndex = 0;
    let i = 0;
    
    while (i < faces.length) {
        const faceType = faces[i++];
        
        // Decode face type bits
        const isQuad = (faceType & 1) !== 0;
        const hasMaterial = (faceType & 2) !== 0;
        const hasFaceUv = (faceType & 4) !== 0;
        const hasFaceVertexUv = (faceType & 8) !== 0;
        const hasFaceNormal = (faceType & 16) !== 0;
        const hasFaceVertexNormal = (faceType & 32) !== 0;
        const hasFaceColor = (faceType & 64) !== 0;
        const hasFaceVertexColor = (faceType & 128) !== 0;
        
        const numVertices = isQuad ? 4 : 3;
        const vertexIndices = [];
        
        // Read vertex indices
        for (let v = 0; v < numVertices; v++) {
            vertexIndices.push(faces[i++]);
        }
        
        // Skip material index
        if (hasMaterial) i++;
        
        // Skip face UV
        if (hasFaceUv) i++;
        
        // Read vertex UVs
        const faceUvIndices = [];
        if (hasFaceVertexUv) {
            for (let v = 0; v < numVertices; v++) {
                faceUvIndices.push(faces[i++]);
            }
        }
        
        // Skip face normal
        if (hasFaceNormal) i++;
        
        // Read vertex normals
        const faceNormalIndices = [];
        if (hasFaceVertexNormal) {
            for (let v = 0; v < numVertices; v++) {
                faceNormalIndices.push(faces[i++]);
            }
        }
        
        // Skip face color
        if (hasFaceColor) i++;
        
        // Skip vertex colors
        if (hasFaceVertexColor) {
            for (let v = 0; v < numVertices; v++) i++;
        }
        
        // Add vertices for this face
        const faceVertexIndices = [];
        for (let v = 0; v < numVertices; v++) {
            const vIdx = vertexIndices[v] * 3;
            positions.push(
                vertices[vIdx] * scale,
                vertices[vIdx + 1] * scale,
                vertices[vIdx + 2] * scale
            );
            
            if (hasFaceVertexNormal && faceNormalIndices[v] !== undefined) {
                const nIdx = faceNormalIndices[v] * 3;
                normalData.push(
                    normals[nIdx] || 0,
                    normals[nIdx + 1] || 0,
                    normals[nIdx + 2] || 0
                );
            } else {
                normalData.push(0, 1, 0);
            }
            
            if (hasFaceVertexUv && faceUvIndices[v] !== undefined) {
                const uIdx = faceUvIndices[v] * 2;
                uvData.push(
                    uvs[uIdx] || 0,
                    uvs[uIdx + 1] || 0
                );
            } else {
                uvData.push(0, 0);
            }
            
            faceVertexIndices.push(vertexIndex++);
        }
        
        // Create triangles from face
        if (isQuad) {
            // Quad: split into 2 triangles
            indices.push(faceVertexIndices[0], faceVertexIndices[1], faceVertexIndices[2]);
            indices.push(faceVertexIndices[0], faceVertexIndices[2], faceVertexIndices[3]);
        } else {
            // Triangle
            indices.push(faceVertexIndices[0], faceVertexIndices[1], faceVertexIndices[2]);
        }
    }
    
    // Get material color - look for meaningful colors
    let baseColor = [0.6, 0.5, 0.4, 1.0]; // Default brown/wood color
    
    // Color mapping based on model name keywords
    const colorMap = {
        'white': [0.95, 0.95, 0.95, 1.0],
        'gray': [0.6, 0.6, 0.6, 1.0],
        'grey': [0.6, 0.6, 0.6, 1.0],
        'blue': [0.2, 0.4, 0.7, 1.0],
        'orange': [0.9, 0.5, 0.2, 1.0],
        'green': [0.3, 0.6, 0.3, 1.0],
        'brown': [0.55, 0.35, 0.2, 1.0],
        'walnut': [0.4, 0.25, 0.15, 1.0],
        'oak': [0.7, 0.55, 0.35, 1.0],
        'whiteoak': [0.8, 0.7, 0.5, 1.0],
        'smoke': [0.4, 0.4, 0.45, 1.0],
        'black': [0.15, 0.15, 0.15, 1.0]
    };
    
    // Check filename for color hints
    const lowerName = fileName.toLowerCase();
    for (const [key, color] of Object.entries(colorMap)) {
        if (lowerName.includes(key)) {
            baseColor = color;
            break;
        }
    }
    
    // Also check materials for explicit colors (not pure white)
    if (materials.length > 0) {
        for (const mat of materials) {
            if (mat.colorDiffuse) {
                const c = mat.colorDiffuse;
                // Skip pure white/gray materials
                if (!(c[0] > 0.9 && c[1] > 0.9 && c[2] > 0.9) && 
                    !(Math.abs(c[0] - c[1]) < 0.05 && Math.abs(c[1] - c[2]) < 0.05)) {
                    baseColor = [c[0], c[1], c[2], 1.0];
                    break;
                }
            }
        }
    }
    
    // Create GLTF structure
    const positionBuffer = new Float32Array(positions);
    const normalBuffer = new Float32Array(normalData);
    const uvBuffer = new Float32Array(uvData);
    const indexBuffer = indices.length < 65536 ? new Uint16Array(indices) : new Uint32Array(indices);
    
    // Calculate bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let j = 0; j < positions.length; j += 3) {
        minX = Math.min(minX, positions[j]);
        minY = Math.min(minY, positions[j + 1]);
        minZ = Math.min(minZ, positions[j + 2]);
        maxX = Math.max(maxX, positions[j]);
        maxY = Math.max(maxY, positions[j + 1]);
        maxZ = Math.max(maxZ, positions[j + 2]);
    }
    
    return {
        positions: positionBuffer,
        normals: normalBuffer,
        uvs: uvBuffer,
        indices: indexBuffer,
        baseColor: baseColor,
        bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
        name: fileName.replace('.js', '')
    };
}

/**
 * Create a GLB binary file from the converted data
 */
function createGlb(data) {
    // Create buffers
    const posBytes = data.positions.buffer.slice(0);
    const normBytes = data.normals.buffer.slice(0);
    const uvBytes = data.uvs.buffer.slice(0);
    const idxBytes = data.indices.buffer.slice(0);
    
    const posLen = posBytes.byteLength;
    const normLen = normBytes.byteLength;
    const uvLen = uvBytes.byteLength;
    const idxLen = idxBytes.byteLength;
    
    // Align to 4 bytes
    const pad = (len) => (4 - (len % 4)) % 4;
    
    const bufferLength = posLen + pad(posLen) + normLen + pad(normLen) + uvLen + pad(uvLen) + idxLen + pad(idxLen);
    
    // Create GLTF JSON
    const gltf = {
        asset: { version: "2.0", generator: "Roomify Model Converter" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: data.name }],
        meshes: [{
            name: data.name,
            primitives: [{
                attributes: {
                    POSITION: 0,
                    NORMAL: 1,
                    TEXCOORD_0: 2
                },
                indices: 3,
                material: 0
            }]
        }],
        materials: [{
            name: "Material",
            pbrMetallicRoughness: {
                baseColorFactor: data.baseColor,
                metallicFactor: 0.0,
                roughnessFactor: 0.8
            }
        }],
        accessors: [
            {
                bufferView: 0,
                componentType: 5126, // FLOAT
                count: data.positions.length / 3,
                type: "VEC3",
                min: data.bounds.min,
                max: data.bounds.max
            },
            {
                bufferView: 1,
                componentType: 5126,
                count: data.normals.length / 3,
                type: "VEC3"
            },
            {
                bufferView: 2,
                componentType: 5126,
                count: data.uvs.length / 2,
                type: "VEC2"
            },
            {
                bufferView: 3,
                componentType: data.indices instanceof Uint16Array ? 5123 : 5125,
                count: data.indices.length,
                type: "SCALAR"
            }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: posLen, target: 34962 },
            { buffer: 0, byteOffset: posLen + pad(posLen), byteLength: normLen, target: 34962 },
            { buffer: 0, byteOffset: posLen + pad(posLen) + normLen + pad(normLen), byteLength: uvLen, target: 34962 },
            { buffer: 0, byteOffset: posLen + pad(posLen) + normLen + pad(normLen) + uvLen + pad(uvLen), byteLength: idxLen, target: 34963 }
        ],
        buffers: [{ byteLength: bufferLength }]
    };
    
    const gltfJson = JSON.stringify(gltf);
    const gltfBytes = Buffer.from(gltfJson);
    const gltfPadding = (4 - (gltfBytes.length % 4)) % 4;
    
    // Create binary buffer
    const binBuffer = Buffer.alloc(bufferLength);
    let offset = 0;
    
    Buffer.from(posBytes).copy(binBuffer, offset); offset += posLen + pad(posLen);
    Buffer.from(normBytes).copy(binBuffer, offset); offset += normLen + pad(normLen);
    Buffer.from(uvBytes).copy(binBuffer, offset); offset += uvLen + pad(uvLen);
    Buffer.from(idxBytes).copy(binBuffer, offset);
    
    // GLB structure
    const glbLength = 12 + 8 + gltfBytes.length + gltfPadding + 8 + bufferLength;
    const glb = Buffer.alloc(glbLength);
    
    offset = 0;
    
    // Header
    glb.writeUInt32LE(0x46546C67, offset); offset += 4; // "glTF"
    glb.writeUInt32LE(2, offset); offset += 4; // version
    glb.writeUInt32LE(glbLength, offset); offset += 4; // total length
    
    // JSON chunk
    glb.writeUInt32LE(gltfBytes.length + gltfPadding, offset); offset += 4;
    glb.writeUInt32LE(0x4E4F534A, offset); offset += 4; // "JSON"
    gltfBytes.copy(glb, offset); offset += gltfBytes.length;
    for (let p = 0; p < gltfPadding; p++) glb[offset++] = 0x20; // space padding
    
    // Binary chunk
    glb.writeUInt32LE(bufferLength, offset); offset += 4;
    glb.writeUInt32LE(0x004E4942, offset); offset += 4; // "BIN"
    binBuffer.copy(glb, offset);
    
    return glb;
}

// Run the converter
convertModels().catch(console.error);
