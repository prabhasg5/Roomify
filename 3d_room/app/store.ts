// The viewer's state. Scene components read it; nothing else holds the Design.

import { create } from "zustand";
import type { Design, PlacedItem, Vec3 } from "./core/types";

interface CatalogueVariant { id: string; model?: string; glb?: string }
interface CatalogueProduct { id: string; variants: CatalogueVariant[] }

/** Catalogue lookups to a GLB url: by "product_id/variant_id", and by legacy model url. */
export interface ModelIndex {
  byId: Map<string, string>;
  byModel: Map<string, string>;
}

export function indexCatalogue(cat: { products: CatalogueProduct[] }): ModelIndex {
  const byId = new Map<string, string>();
  const byModel = new Map<string, string>();
  for (const p of cat.products) {
    for (const v of p.variants) {
      if (!v.glb) continue;
      byId.set(`${p.id}/${v.id}`, v.glb);
      if (v.model) byModel.set(v.model, v.glb);
      byModel.set(v.glb, v.glb);
    }
  }
  return { byId, byModel };
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

interface ViewerState {
  design: Design | null;
  /** What's loaded, for the picker. */
  source: string;
  models: ModelIndex | null;
  /** Model url → bounding-box size before scale, measured from the loaded GLB (holes need it). */
  sizes: Record<string, Vec3>;
  errors: string[];
  load(source: string, design: Design | null): void;
  setModels(models: ModelIndex): void;
  setSize(url: string, size: Vec3): void;
  addError(message: string): void;
}

export const useViewer = create<ViewerState>((set) => ({
  design: null,
  source: "",
  models: null,
  sizes: {},
  errors: [],
  load: (source, design) => set({ source, design, errors: [] }),
  setModels: (models) => set({ models }),
  setSize: (url, size) => set((s) => ({ sizes: { ...s.sizes, [url]: size } })),
  addError: (message) => set((s) => ({ errors: [...s.errors, message] })),
}));
