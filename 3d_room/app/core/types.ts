// Core types for the stage-2 app. Plain data, no react/three. Units: cm. Plan (x, y) → world (x, z).

export interface Point {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Corner extends Point {
  id: string;
}

export interface WallTexture {
  url: string;
  stretch: boolean;
  scale: number;
}

export interface Wall {
  /** Corner ids. The front side runs start → end. */
  start: string;
  end: string;
  height: number;
  thickness: number;
  textures: { front: WallTexture; back: WallTexture };
}

export interface FloorTexture {
  url: string;
  scale: number;
}

/** Legacy item_type values (old items/factory.ts). */
export const ItemType = {
  Floor: 1,
  Wall: 2,
  InWall: 3,
  InWallFloor: 7,
  OnFloor: 8,
  WallFloor: 9,
} as const;

export interface PlacedItem {
  name: string;
  type: number;
  /** Catalogue ids: the published contract that resolves the model. */
  productId?: string;
  variantId?: string;
  /** Legacy fallback lookup keys. */
  modelUrl?: string;
  glbUrl?: string;
  /** Bounding-box centre. */
  position: Vec3;
  /** Radians. */
  rotation: Vec3;
  scale: Vec3;
  fixed: boolean;
}

export interface Design {
  corners: Corner[];
  walls: Wall[];
  /** Room key (sorted corner ids joined by ",") → texture. */
  floorTextures: Record<string, FloorTexture>;
  items: PlacedItem[];
}

/** Doors and windows: the items that cut a hole in their wall. */
export interface Opening {
  item: number;
  wall: number;
}

export interface Rect {
  min: Point;
  max: Point;
}
