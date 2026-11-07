import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, bridgeCaller, type ServerModule } from "@pi-spore/module-api";
import { HealthResponse, parse, ValidationError } from "@pi-spore/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTokenStore } from "./agent-tokens.js";
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
      agentTokens: new AgentTokenStore(),
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

/** A `bridge` module that echoes its caller and counts calls. */
function bridgeModule() {
  let calls = 0;
  const module: ServerModule = {
    id: "bridge",
    requires: [],
    core: false,
    setup(host) {
      host.routes.post("/echo", async (c) => {
        calls++;
        return c.json({ calls, caller: bridgeCaller(c), body: await c.req.json() });
      });
    },
  };
  return { module, calls: () => calls };
}

describe("agent tokens", () => {
  it("open bridge routes, name the caller, and stop working when revoked", async () => {
    const bridge = bridgeModule();
    server = await createTestServer([bridge.module]);
    const token = server.agentTokens.issue({ agentId: "a1", workspaceId: "w1" });
    const asAgent = { "x-pi-spore-token": "", authorization: `Bearer ${token}` };

    const ok = await server.request("POST", "/api/bridge/echo", {}, asAgent);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ caller: { agentId: "a1", workspaceId: "w1" } });

    server.agentTokens.revoke(token);
    expect((await server.request("POST", "/api/bridge/echo", {}, asAgent)).status).toBe(401);
  });

  it("are refused on other routes, and the user's token is refused on bridge routes", async () => {
    const counter = counterModule();
    server = await createTestServer([counter.module, bridgeModule().module]);
    const token = server.agentTokens.issue({ agentId: "a1", workspaceId: "w1" });

    const asAgent = await server.request(
      "POST",
      "/api/counter/bump",
      {},
      { "x-pi-spore-token": "", authorization: `Bearer ${token}` },
    );
    expect(asAgent.status).toBe(401);
    expect(counter.calls()).toBe(0);

    const asUser = await server.request("POST", "/api/bridge/echo", {});
    expect(asUser.status).toBe(401);
    const asUserBearer = await server.request(
      "POST",
      "/api/bridge/echo",
      {},
      { authorization: `Bearer ${TEST_TOKEN}` },
    );
    expect(asUserBearer.status).toBe(401);
  });

  it("scope receipts to the agent: a replayed tool call gets the first answer, another agent's runs", async () => {
    const bridge = bridgeModule();
    server = await createTestServer([bridge.module]);
    const as = (agentId: string) => ({
      "x-pi-spore-token": "",
      authorization: `Bearer ${server?.agentTokens.issue({ agentId, workspaceId: "w" })}`,
      "idempotency-key": "toolu_1",
    });

    const first = await server.request("POST", "/api/bridge/echo", { n: 1 }, as("a1"));
    // A new process of the same agent has a new token; the receipt still holds.
    const replay = await server.request("POST", "/api/bridge/echo", { n: 1 }, as("a1"));
    expect(await replay.json()).toEqual(await first.json());
    expect(bridge.calls()).toBe(1);

    const other = await server.request("POST", "/api/bridge/echo", { n: 1 }, as("a2"));
    expect(await other.json()).toMatchObject({ calls: 2, caller: { agentId: "a2" } });
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
      agentTokens: new AgentTokenStore(),
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
