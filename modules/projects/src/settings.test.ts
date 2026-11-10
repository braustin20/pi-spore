import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerModule } from "@pi-spore/module-api";
import { routerSettingEntries } from "@pi-spore/router";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { parse, SettingsView } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsKey, projectsModule } from "./server.js";

// Passes through to the real router, so a test can make the router answer before the server's own read.
vi.mock("@pi-spore/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pi-spore/router")>();
  return { ...actual, routerSettingEntries: vi.fn(actual.routerSettingEntries) };
});

// The projects module needs a VCS provider before it accepts a project.
const testVcs: ServerModule = {
  id: "test-vcs",
  requires: ["projects"],
  core: true,
  setup(host) {
    const refuse = async (): Promise<never> => {
      throw new Error("no copies in this test");
    };
    // The actions module reserves this section in the real server; it is not loaded here.
    host.settings.reserve("project", "actions");
    host.use(ProjectsKey).registerVcs({
      kind: "test",
      priority: 0,
      detect: async () => true,
      root: async (path) => path,
      isolationModes: ["in-place"],
      createCopy: refuse,
      removeCopy: refuse,
    });
  },
};

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer([projectsModule, testVcs]);
});
afterEach(() => {
  server.close();
  // A queued `mockRejectedValueOnce` that no call used must not reach the next test.
  vi.mocked(routerSettingEntries).mockReset();
});

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

describe("saving settings", () => {
  const settingsPath = () => join(server.paths.root, "settings.json");
  const put = (path: string, body: unknown) => server.request("PUT", `/api/projects${path}`, body);
  type ErrorBody = { error: { code: string; message: string } };

  async function addProject(): Promise<{ id: string; path: string }> {
    const path = mkdtempSync(join(server.paths.root, "project-"));
    mkdirSync(join(path, ".pi-spore"));
    const response = await server.request("POST", "/api/projects", { path });
    expect(response.status).toBe(201);
    const { project } = (await response.json()) as { project: { id: string; path: string } };
    return project;
  }
  const configPath = (project: { path: string }, name: string) =>
    join(project.path, ".pi-spore", name);

  async function expectRefused(response: Response, code: string, mentions: string): Promise<void> {
    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe(code);
    expect(body.error.message).toContain(mentions);
  }

  it("saves a global value and answers with its new source", async () => {
    const response = await put("/settings", { key: "retention.days", value: 7 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      setting: { key: "retention.days", value: 7, source: "global" },
    });
    expect(await retention()).toEqual({ value: 7, source: "global" });
  });

  it("saves a project value to the local override and never writes config.toml", async () => {
    const project = await addProject();
    const response = await put(`/${project.id}/settings`, {
      key: "worktree.branch_prefix",
      value: "feat",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      setting: { key: "worktree.branch_prefix", value: "feat", source: "local override" },
    });
    expect(existsSync(configPath(project, "config.toml"))).toBe(false);
    expect(readFileSync(configPath(project, "config.local.toml"), "utf8")).toContain("feat");
  });

  it("unsets a project value so the project file applies again", async () => {
    const project = await addProject();
    writeFileSync(configPath(project, "config.toml"), '[worktree]\nbranch_prefix = "team"\n');
    writeFileSync(configPath(project, "config.local.toml"), '[worktree]\nbranch_prefix = "mine"\n');
    const response = await put(`/${project.id}/settings`, {
      key: "worktree.branch_prefix",
      unset: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      setting: { key: "worktree.branch_prefix", value: "team", source: "project file" },
    });
  });

  it("unsets a global value so the default applies again", async () => {
    writeSettings('{"retention":{"days":7}}');
    const response = await put("/settings", { key: "retention.days", unset: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      setting: { key: "retention.days", value: 30, source: "default" },
    });
  });

  it("refuses a global value of the wrong type and leaves the file as it was", async () => {
    const text = '{"retention":{"days":7}}';
    writeSettings(text);
    await expectRefused(
      await put("/settings", { key: "retention.days", value: "seven" }),
      "bad_settings",
      "retention.days",
    );
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
  });

  it("refuses a project value of the wrong type and leaves the file as it was", async () => {
    const project = await addProject();
    const text = '[worktree]\nbranch_prefix = "mine"\n';
    writeFileSync(configPath(project, "config.local.toml"), text);
    await expectRefused(
      await put(`/${project.id}/settings`, { key: "worktree.branch_prefix", value: 5 }),
      "bad_project_config",
      "worktree.branch_prefix",
    );
    expect(readFileSync(configPath(project, "config.local.toml"), "utf8")).toBe(text);
  });

  it("refuses an unknown key, naming it", async () => {
    await expectRefused(
      await put("/settings", { key: "retention.dayz", value: 7 }),
      "bad_settings",
      "retention.dayz",
    );
    const project = await addProject();
    await expectRefused(
      await put(`/${project.id}/settings`, { key: "worktree.nope", value: 7 }),
      "bad_project_config",
      "worktree.nope",
    );
  });

  it("refuses a global key on the project route", async () => {
    const project = await addProject();
    await expectRefused(
      await put(`/${project.id}/settings`, { key: "retention.days", value: 7 }),
      "bad_project_config",
      "is a global setting",
    );
  });

  it("checks router keys with the router's own parser", async () => {
    const text = '{"retention":{"days":7}}';
    writeSettings(text);
    await expectRefused(
      await put("/settings", { key: "router.threshold", value: "high" }),
      "bad_settings",
      "threshold",
    );
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);

    const response = await put("/settings", { key: "router.threshold", value: 0.5 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      setting: { key: "router.threshold", value: 0.5, source: "global" },
    });
  });

  // The seam lets a reserved section through for its owner; the page may only change keys it lists (ADR 0170).
  it("refuses a whole router section, naming the key, and leaves the file as it was", async () => {
    const text = '{"retention":{"days":7}}';
    writeSettings(text);
    await expectRefused(
      await put("/settings", { key: "router", value: { threshold: 0.5 } }),
      "bad_settings",
      "router",
    );
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
  });

  it("refuses the actions section on the project route and writes no file", async () => {
    const project = await addProject();
    await expectRefused(
      await put(`/${project.id}/settings`, { key: "actions", value: "invalid" }),
      "bad_project_config",
      "actions",
    );
    expect(existsSync(configPath(project, "config.local.toml"))).toBe(false);
  });

  // The seam checks the new file, so a save may repair a value that is wrong on disk (ADR 0170).
  it("replaces a global value that is invalid on disk", async () => {
    writeSettings('{"retention":{"days":"seven"}}');
    const response = await put("/settings", { key: "retention.days", value: 7 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      setting: { key: "retention.days", value: 7, source: "global" },
    });
  });

  it("unsets a router value that is invalid on disk", async () => {
    writeSettings('{"router":{"threshold":"high"}}');
    const response = await put("/settings", { key: "router.threshold", unset: true });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { setting: { source: string } }).setting.source).toBe(
      "default",
    );
  });

  it("replaces a project value that is invalid on disk", async () => {
    const project = await addProject();
    writeFileSync(configPath(project, "config.local.toml"), "[worktree]\nbranch_prefix = 5\n");
    const response = await put(`/${project.id}/settings`, {
      key: "worktree.branch_prefix",
      value: "feat",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      setting: { key: "worktree.branch_prefix", value: "feat", source: "local override" },
    });
  });

  it("answers 400 for a body with neither value nor unset", async () => {
    expect((await put("/settings", { key: "retention.days" })).status).toBe(400);
    const project = await addProject();
    expect((await put(`/${project.id}/settings`, { key: "worktree.copy" })).status).toBe(400);
  });

  it("answers 404 project_not_found for an unknown project", async () => {
    const response = await put("/nope/settings", { key: "worktree.copy", value: [] });
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorBody).error.code).toBe("project_not_found");
  });
});
