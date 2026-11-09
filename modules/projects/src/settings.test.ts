import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { routerSettingEntries } from "@pi-spore/router";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { parse, SettingsView } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectsModule } from "./server.js";

// Passes through to the real router, so a test can make the router answer before the server's own read.
vi.mock("@pi-spore/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pi-spore/router")>();
  return { ...actual, routerSettingEntries: vi.fn(actual.routerSettingEntries) };
});

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer([projectsModule]);
});
afterEach(() => server.close());

const writeSettings = (text: string) =>
  writeFileSync(join(server.paths.root, "settings.json"), text);

async function entry(key = "retention.days"): Promise<{ value: unknown; source: string }> {
  const response = await server.request("GET", "/api/projects/settings");
  expect(response.status).toBe(200);
  const found = parse(SettingsView, await response.json(), "settings").settings.find(
    (candidate) => candidate.key === key,
  );
  expect(found, `no setting ${key}`).toBeDefined();
  return { value: found?.value, source: found?.source ?? "" };
}
const retention = () => entry();

async function expectBadSettings(text: string, mentions: string): Promise<void> {
  writeSettings(text);
  const response = await server.request("GET", "/api/projects/settings");
  expect(response.status).toBe(422);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("bad_settings");
  expect(body.error.message).toContain(mentions);
  expect(body.error.message).toContain("settings.json");
}

describe("GET /api/projects/settings", () => {
  it("answers 30 days from default when there is no settings file", async () => {
    expect(await retention()).toEqual({ value: 30, source: "default" });
  });

  it("reads retention.days as global", async () => {
    writeSettings('{"retention":{"days":7}}');
    expect(await retention()).toEqual({ value: 7, source: "global" });
  });

  it("reads 0 as global", async () => {
    writeSettings('{"retention":{"days":0}}');
    expect(await retention()).toEqual({ value: 0, source: "global" });
  });

  it("uses the default when the file only holds other sections", async () => {
    writeSettings('{"router":{"threshold":0.5},"tiers":{}}');
    expect(await retention()).toEqual({ value: 30, source: "default" });
  });

  it("lists every key with its source, sorted by key", async () => {
    writeSettings('{"retention":{"days":7}}');
    const response = await server.request("GET", "/api/projects/settings");
    const { settings } = parse(SettingsView, await response.json(), "settings");
    const keys = settings.map((setting) => setting.key);
    expect(keys).toEqual([...keys].sort());
    expect(settings).toEqual(
      expect.arrayContaining([
        { key: "retention.days", value: 7, source: "global" },
        { key: "server.allowedHosts", value: [], source: "default" },
        { key: "server.allowedLogins", value: [], source: "default" },
        { key: "worktree.branch_prefix", value: "spore", source: "default" },
        { key: "worktree.copy", value: [], source: "default" },
      ]),
    );
  });

  // The router reads these keys itself (pi-extensions/router); the page shows them through its parser (R17.1).
  it("shows a router key from settings.json as global and the rest as default", async () => {
    writeSettings('{"router":{"threshold":0.5}}');
    expect(await entry("router.threshold")).toEqual({ value: 0.5, source: "global" });
    expect(await entry("router.maxQueued")).toEqual({ value: 1, source: "default" });
    expect((await entry("tiers")).source).toBe("default");
  });

  it("shows tiers from settings.json as global", async () => {
    writeSettings('{"tiers":{"a/model":"light"}}');
    const tiers = await entry("tiers");
    expect(tiers.source).toBe("global");
    expect(tiers.value).toMatchObject({ "a/model": "light" });
  });

  it.each([
    ["a router value of the wrong type", '{"router":{"threshold":"high"}}', "/router/threshold"],
    ["an unknown router key", '{"router":{"thresh":1}}', "/router"],
    ["a bad tier", '{"tiers":{"a/model":"huge"}}', "/tiers/a~1model"],
    [
      "a router target that routes to itself",
      '{"router":{"localTargets":[{"model":"spore/auto","thinking":"high","contextWindow":1000,"budget":0.5,"concurrency":1,"healthUrl":"http://127.0.0.1:1/health"}]}}',
      "router.localTargets[0].model",
    ],
  ])("refuses %s with 422 bad_settings", async (_name, text, mentions) => {
    await expectBadSettings(text, mentions);
  });

  it("reads the file fresh on each call", async () => {
    writeSettings('{"retention":{"days":7}}');
    expect((await retention()).value).toBe(7);
    writeSettings('{"retention":{"days":9}}');
    expect((await retention()).value).toBe(9);
  });

  // Both parsers refuse "[]" with different words. The server's message must win, whatever answers first.
  it("gives the server's error even when the router fails first", async () => {
    vi.mocked(routerSettingEntries).mockRejectedValueOnce(new Error("router failed first"));
    await expectBadSettings("[]", "JSON object");
  });

  it("refuses an unknown key, naming it and the file", async () => {
    await expectBadSettings('{"retention":{"day":7}}', "retention.day");
  });

  it.each([
    ["negative", '{"retention":{"days":-1}}', "retention.days"],
    ["fractional", '{"retention":{"days":1.5}}', "retention.days"],
    ["a string", '{"retention":{"days":"30"}}', "retention.days"],
    ["a bad retention section", '{"retention":"30"}', "retention"],
    ["a file that is not an object", "[]", "JSON object"],
    ["broken JSON", "{not json", "not valid JSON"],
  ])("refuses %s with 422 bad_settings", async (_name, text, mentions) => {
    await expectBadSettings(text, mentions);
  });
});
