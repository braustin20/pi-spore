import { HealthResponse, parse } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("GET /api/health", () => {
  it("reports status, version, uptime, and modules", async () => {
    const app = createApp({
      version: "1.2.3",
      modules: ["projects", "agents"],
      startedAt: 1_000,
      now: () => 4_500,
    });

    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    const body = parse(HealthResponse, await response.json(), "health response");
    expect(body).toEqual({
      status: "ok",
      version: "1.2.3",
      uptimeMs: 3_500,
      modules: ["projects", "agents"],
    });
  });

  it("answers 404 for unknown routes", async () => {
    const app = createApp({ version: "0.0.0", modules: [], startedAt: 0, now: () => 0 });
    expect((await app.request("/api/nope")).status).toBe(404);
  });
});
