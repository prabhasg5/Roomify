// Types for cad-importer.js (an ESM copy of the old importer, kept as JS so it stays diffable
// against the old example/js/cad-importer.js in git history).

import type { LegacyDesign } from "./design";

/** A dxf-parser entity, or one dwg-importer normalised to that shape. */
export interface CadEntity {
  type: string;
  layer?: string;
  [key: string]: unknown;
}
export interface CadHeader {
  INSUNITS?: number;
  $INSUNITS?: number;
  [key: string]: unknown;
}
export type CadUnit = "mm" | "cm" | "m" | "in" | "ft";

export const CADImporter: {
  parseDxf(dxfContent: string): { entities: CadEntity[]; header: CadHeader };
  detectUnit(header: CadHeader | undefined): CadUnit | null;
  detectWallLayers(entities: CadEntity[]): string[];
  getEntitiesSummary(entities: CadEntity[]): {
    totalEntities: number;
    layers: { name: string; entityCount: number; entityTypes: string }[];
    entityTypes: Record<string, number>;
  };
  entitiesToBlueprint(entities: CadEntity[], sourceUnit: string, layerFilter: string, options?: { collapseWalls?: boolean }): LegacyDesign;
};
