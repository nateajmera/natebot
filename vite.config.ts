import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app is built into dist/web and served by NateBot's own local server.
// Base is relative so the bundle works regardless of which port we land on.
export default defineConfig({
  root: "src/web",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:4319",
      "/events": { target: "ws://127.0.0.1:4319", ws: true },
    },
  },
});
