// The editor's state. Scene components read it; nothing else holds the Design.

import { create } from "zustand";
import type { Design, PlacedItem, Vec3 } from "./core/types";

export interface CatalogueVariant {
  id: string;
  label?: string;
  model?: string;
  glb?: string;
  dimensions?: { width: number; height: number; depth: number };
}
interface CatalogueProduct { id: string; variants: CatalogueVariant[] }

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
  /** Index into design.items. */
  selected: number | null;
  gizmo: GizmoMode;
  load(source: string, design: Design | null): void;
  setModels(models: ModelIndex): void;
  setSize(url: string, size: Vec3): void;
  addError(message: string): void;
  select(index: number | null): void;
  setGizmo(mode: GizmoMode): void;
  /** The one seam for every item edit: move, rotate, scale, fixed, variant. */
  updateItem(index: number, patch: Partial<PlacedItem>): void;
  deleteItem(index: number): void;
}

export const useViewer = create<ViewerState>((set) => ({
  design: null,
  source: "",
  models: null,
  sizes: {},
  errors: [],
  selected: null,
  gizmo: "translate",
  load: (source, design) => set({ source, design, errors: [], selected: null }),
  setModels: (models) => set({ models }),
  setSize: (url, size) => set((s) => ({ sizes: { ...s.sizes, [url]: size } })),
  addError: (message) => set((s) => ({ errors: [...s.errors, message] })),
  select: (selected) => set({ selected }),
  setGizmo: (gizmo) => set({ gizmo }),
  updateItem: (index, patch) =>
    set((s) => (s.design ? { design: { ...s.design, items: s.design.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) } } : {})),
  deleteItem: (index) =>
    set((s) => (s.design ? { design: { ...s.design, items: s.design.items.filter((_, i) => i !== index) }, selected: null } : {})),
}));
