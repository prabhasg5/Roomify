import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// `vite build` bundles the page and the app only. What the app fetches at run time
// (catalogue.json, models/ incl. FastAPI's uploads, rooms/) stays in example/ and is served
// live from there, as the dev server does; uploads arrive after the build, so copying them
// into dist/ would go stale. Whatever serves dist/ in production must serve example/ the same way.
function exampleAssets(): Plugin {
  const types: Record<string, string> = {
    ".glb": "model/gltf-binary", ".json": "application/json", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  };
  return {
    name: "example-assets",
    configurePreviewServer(server) {
      // Registered in the hook body, so it runs before preview's own dist/ middleware.
      const root = path.resolve(server.config.root);
      server.middlewares.use(async (req, res, next) => {
        const file = path.join(root, decodeURIComponent((req.url || "").split("?")[0]));
        // Keep traversal (../) inside example/; the built index.html comes from dist/.
        if (!file.startsWith(root + path.sep) || file.endsWith(".html")) return next();
        try {
          if (!(await stat(file)).isFile()) return next();
        } catch {
          return next();
        }
        res.setHeader("Content-Type", types[path.extname(file).toLowerCase()] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // example/ holds the page (index.html) and the assets the app fetches at run time.
  root: "example",
  plugins: [exampleAssets()],
  // The app lives outside the root, in 3d_room/app/: serve it at /app/.
  resolve: { alias: [{ find: /^\/app\//, replacement: path.resolve(import.meta.dirname, "app") + "/" }] },
  build: { outDir: path.resolve(import.meta.dirname, "dist"), emptyOutDir: true },
  server: {
    port: 5173,
    open: true,
    // Every server job is FastAPI's (backend/main.py). preview.proxy defaults to this.
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: true } },
  },
});
