import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// This file's dir = the Vite project root (`/app` in-container, `<repo>/web` on
// host). `@clawdparty/contracts` is a symlinked workspace package whose real
// source lives in the sibling `packages/` dir — outside the project root — so
// Vite's fs.allow must include it, or a runtime value import from it is refused.
const webDir = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(webDir, "..", "packages");

// The browser/LAN entry point is the published rails:3000 port, NOT 5173 (which
// is unpublished, compose-network only). In the normal Docker flow `rails`
// reverse-proxies the SPA + HMR WS to this unpublished vite service. This config
// makes HMR survive that proxy hop and provides a host-side /api + /~cable proxy
// for running Vite directly on the host (outside the compose stack).
const railsTarget = process.env.VITE_RAILS_TARGET ?? "http://rails:3000";
const usePolling = process.env.VITE_USE_POLLING === "true";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Serve the linked contracts package as source rather than pre-bundling it
  // (its entry is a .ts file resolved via the node_modules symlink).
  optimizeDeps: {
    exclude: ["@clawdparty/contracts"],
  },
  server: {
    // Allow serving the project root AND the sibling packages/ dir (the real
    // target of the @clawdparty/contracts symlink). Without this Vite refuses to
    // serve files outside the root, breaking a runtime value import from it.
    fs: {
      allow: [webDir, packagesDir],
    },
    // Bind all interfaces so the rails reverse-proxy can reach the unpublished
    // vite service over the compose network.
    host: true,
    port: 5173,
    // Vite blocks requests whose Host header isn't allow-listed. The rails
    // reverse-proxy forwards to http://vite:5173 (Host: vite), and host-side dev
    // uses <host>.local — allow the compose service name and the .local suffix.
    allowedHosts: ["vite", ".local", "localhost"],
    hmr: {
      // The HMR WebSocket must point at the rails published port the browser
      // actually connects to, so the upgrade survives the rails->vite proxy hop.
      clientPort: 3000,
    },
    watch: {
      // macOS :delegated bind mounts don't deliver native FS events into the
      // Linux container; poll so host edits trigger HMR. Gated on the env var
      // that dev-docker-compose sets on the vite service.
      usePolling,
    },
    // Convenience for running Vite directly on the host (vite is unpublished, so
    // this is NOT the primary path). Target is configurable — never a hard-coded
    // localhost literal.
    proxy: {
      "/api": {
        target: railsTarget,
        changeOrigin: true,
      },
      "/~cable": {
        target: railsTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
