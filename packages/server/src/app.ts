import type { HealthResponse } from "@pi-spore/shared";
import { Hono } from "hono";

export interface AppOptions {
  version: string;
  /** Enabled module ids in setup order. */
  modules: readonly string[];
  startedAt: number;
  now: () => number;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: options.version,
      uptimeMs: Math.max(0, Math.floor(options.now() - options.startedAt)),
      modules: [...options.modules],
    };
    return c.json(body);
  });

  return app;
}
