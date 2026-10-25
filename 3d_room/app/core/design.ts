// Edge adapters between the legacy wire format (old model.ts exportSerialized / floorplan.ts
// saveFloorplan, also FastAPI's Design model and the AR pages) and the core types.

import type { Design, FloorTexture, WallTexture } from "./types";

export interface LegacyItem {
  item_name: string;
  item_type: number;
  model_url?: string;
  glb_url?: string;
  product_id?: string;
  variant_id?: string;
  xpos: number;
  ypos: number;
  zpos: number;
  rotation: number;
  rotation_x: number;
  rotation_y: number;
  rotation_z: number;
  scale_x: number;
  scale_y: number;
  scale_z: number;
  fixed: boolean;
}

export interface LegacyDesign {
  floorplan: {
    corners: Record<string, { x: number; y: number }>;
    walls: { corner1: string; corner2: string; frontTexture?: WallTexture; backTexture?: WallTexture }[];
    wallTextures: unknown[];
    floorTextures: Record<string, never>;
    newFloorTextures: Record<string, FloorTexture>;
  };
  items: LegacyItem[];
}

// The wire format carries neither, so every wall gets the old engine's defaults (configuration.ts).
export const DEFAULT_WALL_HEIGHT = 250;
export const DEFAULT_WALL_THICKNESS = 10;
export const defaultWallTexture = (): WallTexture => ({ url: "rooms/textures/wallmap.png", stretch: true, scale: 0 });

export function fromDesign(legacy: LegacyDesign): Design {
  const fp = legacy.floorplan;
  return {
    corners: Object.entries(fp.corners).map(([id, c]) => ({ id, x: c.x, y: c.y })),
    walls: fp.walls.map((w) => ({
      start: w.corner1,
      end: w.corner2,
      height: DEFAULT_WALL_HEIGHT,
      thickness: DEFAULT_WALL_THICKNESS,
      textures: {
        front: w.frontTexture ? { ...w.frontTexture } : defaultWallTexture(),
        back: w.backTexture ? { ...w.backTexture } : defaultWallTexture(),
      },
    })),
    floorTextures: structuredClone(fp.newFloorTextures ?? {}),
    items: (legacy.items ?? []).map((it) => ({
      name: it.item_name,
      type: it.item_type,
      productId: it.product_id,
      variantId: it.variant_id,
      modelUrl: it.model_url,
      glbUrl: it.glb_url,
      position: { x: it.xpos, y: it.ypos, z: it.zpos },
      rotation: { x: it.rotation_x, y: it.rotation_y, z: it.rotation_z },
      scale: { x: it.scale_x, y: it.scale_y, z: it.scale_z },
      fixed: it.fixed,
    })),
  };
}

export function toDesign(design: Design): LegacyDesign {
  return {
    floorplan: {
      corners: Object.fromEntries(design.corners.map((c) => [c.id, { x: c.x, y: c.y }])),
      walls: design.walls.map((w) => ({
        corner1: w.start,
        corner2: w.end,
        frontTexture: { ...w.textures.front },
        backTexture: { ...w.textures.back },
      })),
      wallTextures: [],
      floorTextures: {},
      newFloorTextures: structuredClone(design.floorTextures),
    },
    items: design.items.map((it) => ({
      item_name: it.name,
      item_type: it.type,
      model_url: it.modelUrl,
      glb_url: it.glbUrl,
      product_id: it.productId,
      variant_id: it.variantId,
      xpos: it.position.x,
      ypos: it.position.y,
      zpos: it.position.z,
      rotation: it.rotation.y,
      rotation_x: it.rotation.x,
      rotation_y: it.rotation.y,
      rotation_z: it.rotation.z,
      scale_x: it.scale.x,
      scale_y: it.scale.y,
      scale_z: it.scale.z,
      fixed: it.fixed,
    })),
  };
}
