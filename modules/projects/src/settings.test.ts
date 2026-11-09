import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { parse, SettingsView } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectsModule } from "./server.js";

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
    expect(settings).toEqual([
      { key: "retention.days", value: 7, source: "global" },
      { key: "server.allowedHosts", value: [], source: "default" },
      { key: "server.allowedLogins", value: [], source: "default" },
      { key: "worktree.branch_prefix", value: "spore", source: "default" },
      { key: "worktree.copy", value: [], source: "default" },
    ]);
  });

  it("reads the file fresh on each call", async () => {
    writeSettings('{"retention":{"days":7}}');
    expect((await retention()).value).toBe(7);
    writeSettings('{"retention":{"days":9}}');
    expect((await retention()).value).toBe(9);
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
