/**
 * Builds the instant-link edition (src/artifact) as one self-contained script
 * + stylesheet, which scripts/build-artifact.mjs inlines into a single page
 * for publishing as a claude.ai artifact.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist-artifact",
    emptyOutDir: true,
    assetsInlineLimit: 1_000_000,
    cssCodeSplit: false,
    lib: { entry: "src/artifact/main.tsx", formats: ["iife"], name: "PriceActionAnalyst", fileName: () => "app.js" },
  },
});
