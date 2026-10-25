// Types for dwg-importer.js (an ESM copy of the old importer).

import type { CadEntity, CadHeader } from "./cad-importer";

export const DWGImporter: {
  isAvailable(): boolean;
  /** @param wasmDir folder holding libredwg-web.wasm; omitted, the inlined wasm is used. */
  parse(bytes: ArrayBuffer, wasmDir?: string): Promise<{ entities: CadEntity[]; header: CadHeader }>;
  normalizeEntities(db: unknown): CadEntity[];
};
