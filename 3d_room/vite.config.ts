import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// The furniture models in example/models/js are Three.js JSON (format 3.1) but
// carry a .js extension, so Vite's dev server treats each one as a JS module and
// appends an inline sourcemap comment. THREE.JSONLoader does JSON.parse() on the
// response, that trailing comment makes it throw, the load callback never fires,
// and the app's "Loading..." modal never closes. Serve these paths byte-for-byte
// instead. (Express on :9000 never had the problem — it serves them statically.)
function rawJsonModels(): Plugin {
  const PREFIX = "/models/js/";
  return {
    name: "raw-json-models",
    configureServer(server) {
      // Registered in the hook body, so it runs before Vite's transform middleware.
      const modelsDir = path.join(server.config.root, "models", "js");
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (!url.startsWith(PREFIX) || !url.endsWith(".js")) return next();
        const file = path.join(server.config.root, decodeURIComponent(url));
        // Keep traversal (../) inside the models directory.
        if (path.dirname(file) !== modelsDir) return next();
        try {
          await stat(file);
        } catch {
          return next();
        }
        res.setHeader("Content-Type", "application/json");
        createReadStream(file).pipe(res);
      });
    },
  };
}

// Stage 1 (toolchain) Vite config.
// The frontend is still a classic global-<script> app (jQuery, Bootstrap,
// three r69, and the compiled BP3D namespace bundle). Vite is used here purely
// as a fast dev server with live-reload + an /api proxy to the existing Express
// backend (model-server.js on :9000). The TypeScript in src/ is still compiled
// by `tsc` (namespace/outFile mode) into example/js/blueprint3d.js — Vite does
// not bundle it. ES-module migration + a Vite production build come in stage 2.
export default defineConfig({
  // Serve the existing example/ app as the web root.
  root: "example",
  plugins: [rawJsonModels()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Forward backend API calls to the Express server (model upload, models).
      "/api": {
        target: "http://localhost:9000",
        changeOrigin: true,
      },
    },
  },
});
