import { defineInterface, type ServerModule } from "@pi-spore/module-api";
import { HealthResponse, parse } from "@pi-spore/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createTestServer, type TestServer } from "./testing.js";

let server: TestServer | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("setupModules", () => {
  it("sets modules up in dependency order and passes interfaces between them", async () => {
    const Greeting = defineInterface<() => string>("base", "greeting");
    const calls: string[] = [];
    const base: ServerModule = {
      id: "base",
      requires: [],
      core: true,
      setup(host) {
        calls.push("base");
        host.provide(Greeting, () => "hello");
      },
    };
    const feature: ServerModule = {
      id: "feature",
      requires: ["base"],
      core: false,
      setup(host) {
        calls.push(`feature:${host.use(Greeting)()}`);
      },
    };

    server = await createTestServer([feature, base]);

    expect(calls).toEqual(["base", "feature:hello"]);
    const health = parse(
      HealthResponse,
      await (await server.request("GET", "/api/health")).json(),
      "health",
    );
    expect(health.modules).toEqual(["base", "feature"]);
  });

  it("runs no setup when the registry is invalid", async () => {
    const calls: string[] = [];
    const broken: ServerModule = {
      id: "broken",
      requires: ["missing"],
      core: false,
      setup: () => {
        calls.push("broken");
      },
    };

    await expect(createTestServer([broken])).rejects.toThrow(
      'Module "broken" requires "missing", which is not registered',
    );
    expect(calls).toEqual([]);
  });

  it("mounts each module's routes under /api/<id>/", async () => {
    const echo: ServerModule = {
      id: "echo",
      requires: [],
      core: false,
      setup(host) {
        host.routes.get("/ping", (c) => c.json({ pong: true }));
      },
    };
    server = await createTestServer([echo]);

    const response = await server.request("GET", "/api/echo/ping");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
  });
});
