import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    target: "es2022",
    cssTarget: "chrome111",
    assetsInlineLimit: 8192,
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        // three is the only heavy chunk; split it so the shell + login paint
        // before the engine is even parsed.
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "three";
        },
      },
    },
  },
  esbuild: {
    legalComments: "none",
    drop: ["debugger"],
  },
  server: { port: 5173 },
});
