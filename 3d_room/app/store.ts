// The editor's state. Scene components read it; nothing else holds the Design.

import { create } from "zustand";
import { placeNew } from "./core/placement";
import { findRooms } from "./core/rooms";
import type { Design, FloorTexture, PlacedItem, Surface, Vec3, WallTexture } from "./core/types";
import { buildEdges, wallSides } from "./core/walls";

export interface CatalogueVariant {
  id: string;
  label?: string;
  model?: string;
  glb?: string;
  thumbnail?: string;
  dimensions?: { width: number; height: number; depth: number };
  price_delta?: number;
}
export interface CatalogueProduct {
  id: string;
  name: string;
  item_type: number;
  /** Filled by /api/catalogue (curated, else from the price db); absent in the static file. */
  price?: number | null;
  variants: CatalogueVariant[];
}

/** Catalogue lookups to a GLB url: by "product_id/variant_id", and by legacy model url. */
export interface ModelIndex {
  byId: Map<string, string>;
  byModel: Map<string, string>;
  /** product_id → its variants with a GLB, for the variant picker. */
  variants: Map<string, CatalogueVariant[]>;
}

export function indexCatalogue(cat: { products: CatalogueProduct[] }): ModelIndex {
  const byId = new Map<string, string>();
  const byModel = new Map<string, string>();
  const variants = new Map<string, CatalogueVariant[]>();
  for (const p of cat.products) {
    variants.set(p.id, p.variants.filter((v) => v.glb));
    for (const v of p.variants) {
      if (!v.glb) continue;
      byId.set(`${p.id}/${v.id}`, v.glb);
      if (v.model) byModel.set(v.model, v.glb);
      byModel.set(v.glb, v.glb);
    }
  }
  return { byId, byModel, variants };
}

/** Catalogue ids first; model_url only as a fallback key; a bare .glb url loads directly. */
export function resolveModel(item: PlacedItem, index: ModelIndex): string | undefined {
  return (
    index.byId.get(`${item.productId}/${item.variantId}`) ??
    (item.modelUrl ? index.byModel.get(item.modelUrl) : undefined) ??
    item.glbUrl ??
    (item.modelUrl?.endsWith(".glb") ? item.modelUrl : undefined)
  );
}

export type GizmoMode = "translate" | "rotate" | "scale";

interface ViewerState {
  design: Design | null;
  /** What's loaded, for the picker. */
  source: string;
  models: ModelIndex | null;
  /** Model url → bounding-box size before scale, measured from the loaded GLB (holes need it). */
  sizes: Record<string, Vec3>;
  errors: string[];
  /** The catalogue's products, for the catalogue panel. */
  products: CatalogueProduct[];
  /** The wall side or floor last clicked, for the texture picker. */
  surface: Surface | null;
  /** Index into design.items. */
  selected: number | null;
  gizmo: GizmoMode;
  load(source: string, design: Design | null): void;
  setCatalogue(products: CatalogueProduct[], models: ModelIndex): void;
  setSize(url: string, size: Vec3): void;
  addError(message: string): void;
  select(index: number | null): void;
  setGizmo(mode: GizmoMode): void;
  /** The one seam for every item edit: move, rotate, scale, fixed, variant. */
  updateItem(index: number, patch: Partial<PlacedItem>): void;
  deleteItem(index: number): void;
  /** The one seam for new items: placed as the old placeInRoom (size: its box before scale), then selected. */
  addItem(item: PlacedItem, size: Vec3): void;
  clearItems(): void;
  pickSurface(surface: Surface | null): void;
  /** The one seam for textures: one wall side, or one room's floor. */
  setTexture(surface: Surface, texture: WallTexture | FloorTexture): void;
  /** The one seam for every plan edit from 2D (core/plan.ts): corners, walls, and the wall items a delete took. */
  editPlan(next: Design): void;
}

export const useViewer = create<ViewerState>((set) => ({
  design: null,
  source: "",
  models: null,
  sizes: {},
  errors: [],
  products: [],
  surface: null,
  selected: null,
  gizmo: "translate",
  load: (source, design) => set({ source, design, errors: [], selected: null, surface: null }),
  setCatalogue: (products, models) => set({ products, models }),
  setSize: (url, size) => set((s) => ({ sizes: { ...s.sizes, [url]: size } })),
  addError: (message) => set((s) => ({ errors: [...s.errors, message] })),
  // Old TextureSelector: selecting an item hides the texture picker.
  select: (selected) => set(selected === null ? { selected } : { selected, surface: null }),
  setGizmo: (gizmo) => set({ gizmo }),
  updateItem: (index, patch) =>
    set((s) => (s.design ? { design: { ...s.design, items: s.design.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) } } : {})),
  deleteItem: (index) =>
    set((s) => (s.design ? { design: { ...s.design, items: s.design.items.filter((_, i) => i !== index) }, selected: null } : {})),
  addItem: (item, size) =>
    set((s) => {
      if (!s.design) return {};
      const sides = wallSides(buildEdges(s.design, findRooms(s.design)));
      const items = [...s.design.items, { ...item, ...placeNew(item, size, s.design, sides) }];
      return { design: { ...s.design, items }, selected: items.length - 1, surface: null };
    }),
  clearItems: () => set((s) => (s.design ? { design: { ...s.design, items: [] }, selected: null } : {})),
  pickSurface: (surface) => set({ surface }),
  setTexture: (surface, texture) =>
    set((s) => {
      if (!s.design) return {};
      if (surface.kind === "floor") {
        const { url, scale } = texture;
        return { design: { ...s.design, floorTextures: { ...s.design.floorTextures, [surface.room]: { url, scale } } } };
      }
      const side = surface.front ? "front" : "back";
      const walls = s.design.walls.map((w, i) =>
        i === surface.wall ? { ...w, textures: { ...w.textures, [side]: texture as WallTexture } } : w);
      return { design: { ...s.design, walls } };
    }),
  // Items a plan edit keeps are the same objects, so the selection follows its item to its new index.
  editPlan: (next) =>
    set((s) => {
      const item = s.selected !== null ? s.design?.items[s.selected] : undefined;
      const i = item ? next.items.indexOf(item) : -1;
      return { design: next, selected: i >= 0 ? i : null };
    }),
}));
