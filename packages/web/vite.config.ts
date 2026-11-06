import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Build from workspace sources, not their dist output.
    conditions: ["@pi-spore/source"],
  },
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:7420" },
  },
});
