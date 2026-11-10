import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentsModule } from "@pi-spore/mod-agents/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { CalibrationResponse, parse } from "@pi-spore/shared";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAttention } from "./fake-attention.js";
import { fakePipelines } from "./fake-pipelines.js";
import { createUsageModule } from "./server.js";

let server: TestServer | undefined;
afterEach(() => server?.close());

async function start(): Promise<TestServer> {
  server = await createTestServer(
    [
      fakePipelines().module,
      fakeAttention,
      projectsModule,
      workspacesModule,
      agentsModule,
      createUsageModule(),
    ],
    {},
  );
  return server;
}

const settingsPath = (s: TestServer): string => join(s.paths.root, "settings.json");
const readSettings = (s: TestServer): unknown => JSON.parse(readFileSync(settingsPath(s), "utf8"));

const ladders = [
  {
    plan: "claude",
    rungs: [
      { model: "anthropic/haiku", thinking: "off" },
      { model: "anthropic/sonnet", thinking: "low" },
      { model: "anthropic/opus", thinking: "high" },
    ],
  },
];

describe("PATCH /api/usage/router", () => {
  it("sets the threshold and leaves the other keys as they were", async () => {
    const s = await start();
    writeFileSync(
      settingsPath(s),
      JSON.stringify({ other: { keep: true }, router: { ladders, threshold: 0.7 } }),
    );
    const response = await s.request("PATCH", "/api/usage/router", { threshold: 0.4 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threshold: 0.4, explore: 0 });
    expect(readSettings(s)).toEqual({ other: { keep: true }, router: { ladders, threshold: 0.4 } });
  });

  it("turns explore off by removing the key", async () => {
    const s = await start();
    writeFileSync(settingsPath(s), JSON.stringify({ router: { threshold: 0.6, explore: 0.1 } }));
    const response = await s.request("PATCH", "/api/usage/router", { explore: 0 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threshold: 0.6, explore: 0 });
    expect(readSettings(s)).toEqual({ router: { threshold: 0.6 } });
  });

  it("answers 422 bad_settings and leaves a bad file unchanged", async () => {
    const s = await start();
    const text = JSON.stringify({ router: { cloud: [], threshold: 0.7 } });
    writeFileSync(settingsPath(s), text);
    const response = await s.request("PATCH", "/api/usage/router", { threshold: 0.4 });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "bad_settings" } });
    expect(readFileSync(settingsPath(s), "utf8")).toBe(text);
  });

  it("answers 422 and writes nothing for a file that is not JSON", async () => {
    const s = await start();
    writeFileSync(settingsPath(s), "{ nope");
    const response = await s.request("PATCH", "/api/usage/router", { threshold: 0.4 });
    expect(response.status).toBe(422);
    expect(readFileSync(settingsPath(s), "utf8")).toBe("{ nope");
  });

  it.each([
    ["a null file", "null"],
    ["a number file", "42"],
    ["an array file", "[]"],
    ["a null router", '{"router":null}'],
    ["an array router", '{"router":[]}'],
  ])("answers 422 and leaves the file unchanged for %s", async (_name, text) => {
    const s = await start();
    writeFileSync(settingsPath(s), text);
    for (const body of [{ threshold: 0.4 }, {}]) {
      const response = await s.request("PATCH", "/api/usage/router", body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "bad_settings" } });
      expect(readFileSync(settingsPath(s), "utf8")).toBe(text);
    }
  });

  it("keeps both changes when two requests overlap", async () => {
    const s = await start();
    writeFileSync(settingsPath(s), JSON.stringify({ router: { threshold: 0.7, explore: 0.1 } }));
    const responses = await Promise.all([
      s.request("PATCH", "/api/usage/router", { threshold: 0.4 }),
      s.request("PATCH", "/api/usage/router", { explore: 0 }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(readSettings(s)).toEqual({ router: { threshold: 0.4 } });
  });

  it("creates the file when it is missing", async () => {
    const s = await start();
    expect(existsSync(settingsPath(s))).toBe(false);
    const response = await s.request("PATCH", "/api/usage/router", { threshold: 0.4 });
    expect(response.status).toBe(200);
    expect(readSettings(s)).toEqual({ router: { threshold: 0.4 } });
  });

  it("rejects explore other than 0 with 400", async () => {
    const s = await start();
    const response = await s.request("PATCH", "/api/usage/router", { explore: 0.2 });
    expect(response.status).toBe(400);
    expect(existsSync(settingsPath(s))).toBe(false);
  });
});

describe("GET /api/usage/calibration explore", () => {
  const explore = async (s: TestServer): Promise<number> => {
    const response = await s.request("GET", "/api/usage/calibration");
    expect(response.status).toBe(200);
    return parse(CalibrationResponse, await response.json(), "calibration").explore;
  };

  it("is 0 by default and the file's value when set", async () => {
    const s = await start();
    expect(await explore(s)).toBe(0);
    writeFileSync(settingsPath(s), JSON.stringify({ router: { explore: 0.25 } }));
    expect(await explore(s)).toBe(0.25);
  });
});
