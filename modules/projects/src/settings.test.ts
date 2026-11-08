import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { GlobalSettingsView, parse } from "@pi-spore/shared";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectsModule } from "./server.js";

const SettingsBody = Type.Object({ settings: GlobalSettingsView });

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer([projectsModule]);
});
afterEach(() => server.close());

const writeSettings = (text: string) =>
  writeFileSync(join(server.paths.root, "settings.json"), text);

async function retention(): Promise<{ value: number; source: string }> {
  const response = await server.request("GET", "/api/projects/settings");
  expect(response.status).toBe(200);
  return parse(SettingsBody, await response.json(), "settings").settings.retentionDays;
}

async function expectBadSettings(text: string, mentions = "retention.days"): Promise<void> {
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

  it("reads the file fresh on each call", async () => {
    writeSettings('{"retention":{"days":7}}');
    expect((await retention()).value).toBe(7);
    writeSettings('{"retention":{"days":9}}');
    expect((await retention()).value).toBe(9);
  });

  it.each([
    ["negative", '{"retention":{"days":-1}}'],
    ["fractional", '{"retention":{"days":1.5}}'],
    ["a string", '{"retention":{"days":"30"}}'],
    ["a bad retention section", '{"retention":"30"}'],
    ["a file that is not an object", "[]"],
  ])("refuses %s with 422 bad_settings", async (_name, text) => {
    await expectBadSettings(text);
  });

  it("refuses broken JSON with 422 bad_settings", async () => {
    await expectBadSettings("{not json");
  });
});
