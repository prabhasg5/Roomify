import { describe, expect, it } from "vitest";
import { heavy, indexCatalogue, resolveModel } from "./store";
import type { PlacedItem } from "./core/types";

// The problem GLB as POST /api/uploads records it.
const problem = { triangles: 281_513, bytes: 10_585_432, textures: [{ width: 3072, height: 3072, mime_type: "image/png" }, { width: 3072, height: 3072, mime_type: "image/png" }] };

describe("uploads", () => {
  it("warns about heavy models, not light ones", () => {
    expect(heavy(problem)).toEqual(["281,513 triangles", "2 textures over 2048 px (3072×3072, 3072×3072)"]);
    expect(heavy({ triangles: 13_664, bytes: 688_924, textures: [{ width: 512, height: 512, mime_type: "image/png" }] })).toEqual([]);
    expect(heavy({ triangles: 10, bytes: 30 * 1024 * 1024, textures: [] })).toEqual(["30.0 MB"]);
    expect(heavy(undefined)).toEqual([]);
  });

  it("resolves an upload by its ids and knows its unit", () => {
    const glb = "models/uploads/white-sofa.glb";
    const index = indexCatalogue({ products: [{ id: "white-sofa", name: "White sofa", item_type: 1, variants: [{ id: "default", glb, unit_scale: 100, stats: problem }] }] });
    expect(resolveModel({ productId: "white-sofa", variantId: "default", modelUrl: glb } as PlacedItem, index)).toBe(glb);
    expect(index.units.get(glb)).toBe(100);
  });

  it("reports a deleted upload as missing instead of fetching its old url", () => {
    const index = indexCatalogue({ products: [] });
    const glb = "models/uploads/test-couch.glb";
    expect(resolveModel({ productId: "test-couch", variantId: "default", modelUrl: glb } as PlacedItem, index)).toBeUndefined();
    expect(resolveModel({ modelUrl: glb } as PlacedItem, index)).toBe(glb); // no ids: loads directly, as before
  });
});
