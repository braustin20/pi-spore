import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Context } from "hono";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/**
 * Serves the built web app. The API token goes into index.html as a meta tag: only pages served from this origin can
 * read it, because the server sends no CORS headers.
 */
export function serveWeb(dist: string, token: string) {
  const root = normalize(dist + sep);
  return async (c: Context) => {
    const requested = c.req.path === "/" ? "/index.html" : decodeURIComponent(c.req.path);
    const file = normalize(join(root, requested));
    if (!file.startsWith(root)) return c.text("Not found", 404);
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      return c.text("Not found", 404);
    }
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    if (file.endsWith("index.html")) {
      const html = content
        .toString("utf8")
        .replace("</head>", `<meta name="pi-spore-token" content="${token}" /></head>`);
      return c.body(html, 200, { "content-type": type, "cache-control": "no-store" });
    }
    return c.body(new Uint8Array(content), 200, { "content-type": type });
  };
}
