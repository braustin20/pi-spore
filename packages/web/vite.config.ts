import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the page comes from Vite, not from the pi-spore server, so it has no token meta tag. The proxy adds the
// token instead. Start the server once first so the token file exists.
function devToken(): string {
  const path = join(process.env.PI_SPORE_HOME ?? join(homedir(), ".pi-spore"), "token");
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Build from workspace sources, not their dist output.
    conditions: ["@pi-spore/source"],
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api/ws": {
        target: `ws://127.0.0.1:${process.env.PI_SPORE_PORT ?? "7420"}`,
        ws: true,
        rewrite: (path) =>
          `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(devToken())}`,
      },
      "/api": {
        target: `http://127.0.0.1:${process.env.PI_SPORE_PORT ?? "7420"}`,
        headers: { "x-pi-spore-token": devToken() },
      },
    },
  },
});
