import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import { HealthResponse, parse, ValidationError } from "@pi-spore/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_MIGRATIONS, createApp } from "./app.js";
import { SqliteStore } from "./store.js";
import { createTestServer, silentLog, TEST_TOKEN, type TestServer } from "./testing.js";

let server: TestServer | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A module whose routes count calls, so tests can see whether a handler ran again. */
function counterModule() {
  let calls = 0;
  const module: ServerModule = {
    id: "counter",
    requires: [],
    core: false,
    setup(host) {
      host.routes.post("/bump", async (c) => {
        calls++;
        return c.json({ calls, body: await c.req.json() }, 201);
      });
      host.routes.post("/fail", () => {
        calls++;
        throw new Error("boom");
      });
      host.routes.get("/missing", () => {
        throw new ApiError(404, "no_such_thing", "There is no such thing");
      });
      host.routes.get("/invalid", () => {
        throw new ValidationError("Invalid request body: /name: required");
      });
    },
  };
  return { module, calls: () => calls };
}

describe("GET /api/health", () => {
  it("reports status, version, uptime, and modules without a token", async () => {
    const store = new SqliteStore(":memory:");
    store.migrate("core", CORE_MIGRATIONS);
    const app = createApp({
      version: "1.2.3",
      modules: [],
      startedAt: 1_000,
      now: () => 4_500,
      token: TEST_TOKEN,
      store,
      log: silentLog,
    });

    const response = await app.request("/api/health", { headers: { host: "127.0.0.1:7420" } });

    expect(response.status).toBe(200);
    expect(parse(HealthResponse, await response.json(), "health")).toEqual({
      status: "ok",
      version: "1.2.3",
      uptimeMs: 3_500,
      modules: [],
    });
    store.close();
  });
});

describe("request guards", () => {
  it("rejects a non-loopback Host header, even with the token", async () => {
    server = await createTestServer([]);
    const response = await server.request("GET", "/api/health", undefined, {
      host: "evil.example:7420",
    });
    expect(response.status).toBe(403);
  });

  it.each(["localhost:7420", "127.0.0.1", "[::1]:7420"])(
    "accepts the loopback host %s",
    async (host) => {
      server = await createTestServer([]);
      expect((await server.request("GET", "/api/health", undefined, { host })).status).toBe(200);
    },
  );

  it("rejects API requests without the right token", async () => {
    server = await createTestServer([counterModule().module]);
    const wrong = await server.request(
      "POST",
      "/api/counter/bump",
      {},
      { "x-pi-spore-token": "nope" },
    );
    expect(wrong.status).toBe(401);
  });

  it("accepts the token as a bearer header", async () => {
    server = await createTestServer([counterModule().module]);
    const response = await server.request(
      "POST",
      "/api/counter/bump",
      {},
      { "x-pi-spore-token": "", authorization: `Bearer ${TEST_TOKEN}` },
    );
    expect(response.status).toBe(201);
  });

  it("answers unknown API routes with a JSON 404", async () => {
    server = await createTestServer([]);
    const response = await server.request("GET", "/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "No route /api/nope" },
    });
  });
});

describe("idempotency keys", () => {
  it("replays the stored answer for a repeated key without running the handler again", async () => {
    const counter = counterModule();
    server = await createTestServer([counter.module]);
    const headers = { "idempotency-key": "k1" };

    const first = await server.request("POST", "/api/counter/bump", { n: 1 }, headers);
    const second = await server.request("POST", "/api/counter/bump", { n: 1 }, headers);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ calls: 1, body: { n: 1 } });
    expect(counter.calls()).toBe(1);
  });

  it("rejects a reused key with a different body", async () => {
    const counter = counterModule();
    server = await createTestServer([counter.module]);
    await server.request("POST", "/api/counter/bump", { n: 1 }, { "idempotency-key": "k1" });

    const reuse = await server.request(
      "POST",
      "/api/counter/bump",
      { n: 2 },
      { "idempotency-key": "k1" },
    );

    expect(reuse.status).toBe(422);
    expect(counter.calls()).toBe(1);
  });

  it("runs the handler each time without a key", async () => {
    const counter = counterModule();
    server = await createTestServer([counter.module]);
    await server.request("POST", "/api/counter/bump", {});
    await server.request("POST", "/api/counter/bump", {});
    expect(counter.calls()).toBe(2);
  });

  it("does not store server errors, so a retry runs again", async () => {
    const counter = counterModule();
    server = await createTestServer([counter.module]);
    const headers = { "idempotency-key": "k2" };

    expect((await server.request("POST", "/api/counter/fail", {}, headers)).status).toBe(500);
    expect((await server.request("POST", "/api/counter/fail", {}, headers)).status).toBe(500);
    expect(counter.calls()).toBe(2);
  });
});

describe("errors", () => {
  it("turns an ApiError into its status and code", async () => {
    server = await createTestServer([counterModule().module]);
    const response = await server.request("GET", "/api/counter/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "no_such_thing", message: "There is no such thing" },
    });
  });

  it("turns a ValidationError into a 400", async () => {
    server = await createTestServer([counterModule().module]);
    const response = await server.request("GET", "/api/counter/invalid");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
  });

  it("hides other errors behind a 500", async () => {
    server = await createTestServer([counterModule().module]);
    const response = await server.request("POST", "/api/counter/fail", {});
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("boom");
  });
});

describe("web app", () => {
  it("serves index.html with the token and refuses paths outside the build folder", async () => {
    const dist = mkdtempSync(join(tmpdir(), "pi-spore-web-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(
      join(dist, "index.html"),
      "<html><head><title>x</title></head><body></body></html>",
    );
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    const store = new SqliteStore(":memory:");
    store.migrate("core", CORE_MIGRATIONS);
    const app = createApp({
      version: "0",
      modules: [],
      startedAt: 0,
      now: () => 0,
      token: TEST_TOKEN,
      store,
      log: silentLog,
      webDist: dist,
    });
    const get = (path: string) => app.request(path, { headers: { host: "127.0.0.1:7420" } });

    const index = await get("/");
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain(`<meta name="pi-spore-token" content="${TEST_TOKEN}" />`);
    expect(await (await get("/assets/app.js")).text()).toBe("console.log(1)");
    expect((await get("/../../etc/passwd")).status).toBe(404);
    expect((await get("/assets/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);

    store.close();
    rmSync(dist, { recursive: true, force: true });
  });
});
