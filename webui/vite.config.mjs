import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const runtimeProxy = () => ({
  "/api": {
    target: "http://127.0.0.1:4174",
  },
  "/ws": {
    target: "ws://127.0.0.1:4174",
    ws: true,
  },
});

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("recharts") || id.includes("d3-")) return "charts";
          if (id.includes("@tabler")) return "icons";
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    proxy: runtimeProxy(),
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  preview: {
    host: "127.0.0.1",
    proxy: runtimeProxy(),
  },
  plugins: [react()],
});
