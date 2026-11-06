import { createHash } from "node:crypto";
import { ApiError, type Logger, type Store } from "@pi-spore/module-api";
import { type HealthResponse, ValidationError } from "@pi-spore/shared";
import { Hono } from "hono";
import { tokensMatch } from "./token.js";
import { serveWeb } from "./web.js";

export interface AppOptions {
  version: string;
  /** Enabled modules in setup order, with the routes each one registered. */
  modules: readonly { id: string; routes: Hono }[];
  startedAt: number;
  now: () => number;
  token: string;
  store: Store;
  log: Logger;
  /** Built web app to serve at `/`. Absent in tests and when the web app is not built. */
  webDist?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const CORE_MIGRATIONS = [
  `CREATE TABLE core_idempotency (
    key TEXT PRIMARY KEY,
    request TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

function hostname(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  // DNS rebinding: a web page can point its own domain at 127.0.0.1. Its requests then carry that domain as Host.
  app.use("*", async (c, next) => {
    if (!LOOPBACK_HOSTS.has(hostname(c.req.header("host")) ?? "")) {
      return c.json(
        { error: { code: "bad_host", message: "pi-spore answers only on loopback hosts" } },
        403,
      );
    }
    await next();
  });

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: options.version,
      uptimeMs: Math.max(0, Math.floor(options.now() - options.startedAt)),
      modules: options.modules.map((module) => module.id),
    };
    return c.json(body);
  });

  // Every other API route needs the token. A custom header also stops cross-site form posts: browsers cannot add it
  // without a CORS preflight, which this server never approves.
  app.use("/api/*", async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
    // An empty header counts as absent, so it cannot hide a valid bearer token.
    if (!tokensMatch(options.token, c.req.header("x-pi-spore-token") || bearer)) {
      return c.json(
        { error: { code: "unauthorized", message: "Missing or wrong pi-spore token" } },
        401,
      );
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (!MUTATING.has(c.req.method) || key === undefined) return next();
    const bodyHash = createHash("sha256")
      .update(await c.req.raw.clone().text())
      .digest("hex");
    const request = `${c.req.method} ${c.req.path} ${bodyHash}`;
    const stored = options.store.get<{ request: string; status: number; body: string }>(
      "SELECT request, status, body FROM core_idempotency WHERE key = ?",
      key,
    );
    if (stored) {
      if (stored.request !== request) {
        return c.json(
          {
            error: {
              code: "idempotency_mismatch",
              message: "This Idempotency-Key was used for another request",
            },
          },
          422,
        );
      }
      return c.newResponse(stored.body, stored.status as 200, {
        "content-type": "application/json",
      });
    }
    await next();
    // Server errors are not stored, so a retry can succeed.
    if (c.res.status < 500) {
      const body = await c.res.clone().text();
      options.store.run(
        "INSERT OR IGNORE INTO core_idempotency (key, request, status, body, created_at) VALUES (?, ?, ?, ?, ?)",
        key,
        request,
        c.res.status,
        body,
        options.now(),
      );
    }
  });

  for (const module of options.modules) app.route(`/api/${module.id}`, module.routes);

  app.all("/api/*", (c) =>
    c.json({ error: { code: "not_found", message: `No route ${c.req.path}` } }, 404),
  );

  if (options.webDist) app.get("*", serveWeb(options.webDist, options.token));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof ValidationError) {
      return c.json({ error: { code: "invalid_request", message: error.message } }, 400);
    }
    options.log.error("Unhandled error", {
      path: c.req.path,
      error: String(error),
      stack: (error as Error).stack,
    });
    return c.json(
      { error: { code: "internal", message: "Internal error; see the server log" } },
      500,
    );
  });

  return app;
}
