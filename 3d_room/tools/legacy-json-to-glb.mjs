// One-off (stage 2, step 3): writes a real GLB for every catalogue variant into
// example/models/glb/, so the new renderer can drop the r69 Three.js JSON meshes.
//
// - Legacy variants: decode Three.js JSON format 3.1 (as r69 JSONLoader does —
//   vertices × 1/scale, per-face bitmask, quads split a-b-d / b-c-d) into one
//   primitive per material. mapDiffuse → baseColor texture, colorDiffuse →
//   baseColorFactor, metallic 0, roughness 0.8. Units stay cm, geometry is not
//   re-centred (the renderer re-centres on the bounding box).
// - Uploaded variants: the original upload, untouched except for one root node
//   scaling metres → cm (so every catalogue GLB is in cm), and metallic → 0 on
//   materials with no metallic-roughness texture. The r69 copies of
//   these came from a converter that ignored node transforms, so their shape
//   (and catalogue dimensions) were wrong.
//
// Then run `node tools/build-catalogue.js` to fill `glb` + dimensions, and
// `npm run check:catalogue`.
//
// Run: node tools/legacy-json-to-glb.mjs
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune, weld } from "@gltf-transform/functions";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = path.join(root, "example");
const catalogue = JSON.parse(readFileSync(path.join(example, "catalogue.json"), "utf8"));

// catalogue `model` → [original upload, its `glb` in user-models.json].
const UPLOADS = {
  "models/js/couch-1771955277196_baked.js": ["uploads-debug/couch.glb", "models/glb/couch-1771955277196.glb"],
  "models/js/sofa-2-1773380818620_baked.js": ["uploads-debug/sofa-2.glb", "models/glb/sofa-2-1773380818620.glb"],
};

// mapDiffuse files that were never shipped (not here, not in upstream
// furnishup/blueprint3d): sRGB colour sampled from each product's thumbnail,
// used instead of colorDiffuse. kivine reads as blown-out white → r69's 0xeeeeee.
const MISSING_TEXTURE_COLOUR = {
  "pine_wood_coloured.jpg": [0.75, 0.66, 0.58],          // dining-table/default-2 top
  "cb-moore_baked.png": [0.13, 0.1, 0.09],               // media-console/black, espresso
  "we-crosby2piece-green_baked.png": [0.36, 0.34, 0.27], // sectional/olive, tweed
  "ik-kivine_baked.png": [0xee / 255, 0xee / 255, 0xee / 255], // wardrobe/white
};

// r69 renders colours with no colour management; glTF factors are linear.
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function convert(jsonPath) {
  const json = JSON.parse(readFileSync(jsonPath, "utf8"));
  const s = json.scale !== undefined ? 1 / json.scale : 1;
  const V = json.vertices, N = json.normals || [], UV = (json.uvs || [])[0] || [];
  const nUvLayers = (json.uvs || []).filter((l) => l.length).length;

  // Per material: flat, unwelded corner streams. weld() indexes them later.
  const groups = new Map();
  const corner = (g, vi, ni, ti) => {
    g.pos.push(V[vi * 3] * s, V[vi * 3 + 1] * s, V[vi * 3 + 2] * s);
    if (ni >= 0) {
      const x = N[ni * 3], y = N[ni * 3 + 1], z = N[ni * 3 + 2], l = Math.hypot(x, y, z) || 1;
      g.nrm.push(x / l, y / l, z / l);
    }
    if (ti >= 0) g.uv.push(UV[ti * 2], 1 - UV[ti * 2 + 1]); // r69 flipY → glTF top-left origin
  };

  const F = json.faces;
  for (let i = 0; i < F.length; ) {
    const t = F[i++];
    const nv = t & 1 ? 4 : 3;
    const v = F.slice(i, (i += nv));
    const mat = t & 2 ? F[i++] : 0;
    if (t & 4) i += nUvLayers; // face uv: unused by these models
    let uv = [];
    if (t & 8) { uv = F.slice(i, i + nv); i += nv * nUvLayers; }
    if (t & 16) i++; // face normal: these models all carry vertex normals
    let nrm = [];
    if (t & 32) { nrm = F.slice(i, (i += nv)); }
    if (t & 64) i++; // face colour: r69 ignores it unless vertexColors is set (never here)
    if (t & 128) i += nv; // vertex colours: same

    if (!groups.has(mat)) groups.set(mat, { pos: [], nrm: [], uv: [], hasN: !!nrm.length, hasUV: !!uv.length });
    const g = groups.get(mat);
    const tris = nv === 4 ? [[0, 1, 3], [1, 2, 3]] : [[0, 1, 2]];
    for (const tri of tris)
      for (const k of tri) corner(g, v[k], g.hasN ? nrm[k] : -1, g.hasUV ? uv[k] : -1);
  }

  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh(path.basename(jsonPath, ".js"));
  const textures = new Map();
  const dir = path.dirname(jsonPath);
  const missing = [];

  for (const [mi, g] of groups) {
    const m = (json.materials || [])[mi] || {};
    const c = MISSING_TEXTURE_COLOUR[m.mapDiffuse] ||
      m.colorDiffuse || [0xee / 255, 0xee / 255, 0xee / 255]; // r69 default 0xeeeeee
    const opacity = m.transparent && m.transparency !== undefined ? m.transparency : 1;
    const material = doc
      .createMaterial(m.DbgName || `material_${mi}`)
      .setBaseColorFactor([...c.map(linear), opacity])
      .setMetallicFactor(0)
      .setRoughnessFactor(0.8)
      .setDoubleSided(!!m.doubleSided)
      .setAlphaMode(opacity < 1 ? "BLEND" : "OPAQUE");

    if (m.mapDiffuse) {
      const file = path.join(dir, m.mapDiffuse);
      if (!existsSync(file)) missing.push(m.mapDiffuse + (MISSING_TEXTURE_COLOUR[m.mapDiffuse] ? " (thumbnail colour)" : ""));
      else {
        if (!textures.has(file)) {
          const mime = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
          textures.set(file, doc.createTexture(m.mapDiffuse).setImage(readFileSync(file)).setMimeType(mime));
        }
        material.setBaseColorTexture(textures.get(file));
      }
    }

    const prim = doc.createPrimitive().setMaterial(material)
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(g.pos)).setBuffer(buffer));
    if (g.nrm.length) prim.setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(g.nrm)).setBuffer(buffer));
    if (g.uv.length) prim.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(g.uv)).setBuffer(buffer));
    mesh.addPrimitive(prim);
  }

  doc.createScene().addChild(doc.createNode(mesh.getName()).setMesh(mesh));
  return { doc, missing, faces: [...groups.values()].reduce((n, g) => n + g.pos.length / 9, 0) };
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const product of catalogue.products) {
  for (const variant of product.variants) {
    const id = `${product.id}/${variant.id}`;
    if (UPLOADS[variant.model]) {
      const [from, to] = UPLOADS[variant.model];
      const doc = await io.read(path.join(root, from));
      const scene = doc.getRoot().listScenes()[0];
      const cm = doc.createNode("m_to_cm").setScale([100, 100, 100]);
      for (const child of scene.listChildren()) cm.addChild(child);
      // The chrome bug: metallic>0 with no metallic-roughness texture (couch's Material.001
      // is white, metallic 1, roughness 1 — not a real metal).
      for (const mat of doc.getRoot().listMaterials())
        if (mat.getMetallicFactor() > 0 && !mat.getMetallicRoughnessTexture()) {
          console.log(`${id.padEnd(26)}   ${mat.getName()}: metallic ${mat.getMetallicFactor()} → 0`);
          mat.setMetallicFactor(0);
        }
      scene.addChild(cm);
      await io.write(path.join(example, to), doc);
      console.log(`${id.padEnd(26)} ← ${from} (original upload, ×100 root node for cm)`);
      continue;
    }
    // Same basename as the .js — build-catalogue.js finds it by that convention.
    const out = path.join(example, "models", "glb", path.basename(variant.model, ".js") + ".glb");
    const { doc, missing, faces } = convert(path.join(example, variant.model));
    await doc.transform(weld(), prune());
    await io.write(out, doc);
    console.log(`${id.padEnd(26)} → ${path.relative(root, out)}  ${faces} tris` +
      (missing.length ? `  ⚠ texture missing on disk: ${missing.join(", ")}` : ""));
  }
}
