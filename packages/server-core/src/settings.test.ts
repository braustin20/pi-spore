import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettings } from "./settings.js";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-spore-settings-"));
  project = mkdtempSync(join(tmpdir(), "pi-spore-settings-project-"));
  mkdirSync(join(project, ".pi-spore"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const global = (text: string) => writeFileSync(join(home, "settings.json"), text);
const projectFile = (text: string) =>
  writeFileSync(join(project, ".pi-spore", "config.toml"), text);
const localFile = (text: string) =>
  writeFileSync(join(project, ".pi-spore", "config.local.toml"), text);

function makeSettings() {
  const settings = createSettings(home);
  const prefix = settings.declare({
    key: "worktree.branch_prefix",
    schema: Type.String({ pattern: "^[a-z]+$" }),
    default: "spore",
    scope: "project",
  });
  const days = settings.declare({
    key: "retention.days",
    schema: Type.Integer({ minimum: 0 }),
    default: 30,
    scope: "global",
  });
  settings.reserve("project", "actions");
  settings.reserve("global", "router");
  return { settings, prefix, days };
}

describe("resolve order (R17.2)", () => {
  it("uses the default when no file sets the key", async () => {
    const { settings, prefix } = makeSettings();
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(prefix)).toEqual({ value: "spore", source: "default" });
  });

  it("lets the global file beat the default", async () => {
    global('{"worktree":{"branch_prefix":"glob"}}');
    const { settings, prefix } = makeSettings();
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(prefix)).toEqual({ value: "glob", source: "global" });
  });

  it("lets the project file beat global", async () => {
    global('{"worktree":{"branch_prefix":"glob"}}');
    projectFile('[worktree]\nbranch_prefix = "proj"\n');
    const { settings, prefix } = makeSettings();
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(prefix)).toEqual({ value: "proj", source: "project file" });
  });

  it("lets the local override beat the project file", async () => {
    global('{"worktree":{"branch_prefix":"glob"}}');
    projectFile('[worktree]\nbranch_prefix = "proj"\n');
    localFile('[worktree]\nbranch_prefix = "loc"\n');
    const { settings, prefix } = makeSettings();
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(prefix)).toEqual({ value: "loc", source: "local override" });
  });

  it("puts a detected value above the default and below every file", async () => {
    const { settings, prefix } = makeSettings();
    const detected = { "worktree.branch_prefix": "found" };
    expect((await settings.resolve({ projectPath: project, detected })).get(prefix)).toEqual({
      value: "found",
      source: "detected",
    });
    global('{"worktree":{"branch_prefix":"glob"}}');
    expect((await settings.resolve({ projectPath: project, detected })).get(prefix)).toEqual({
      value: "glob",
      source: "global",
    });
  });

  it("reads only the global file without a project", async () => {
    projectFile('[worktree]\nbranch_prefix = "proj"\n');
    const { settings, prefix, days } = makeSettings();
    const resolved = await settings.resolve();
    expect(resolved.get(prefix)).toEqual({ value: "spore", source: "default" });
    expect(resolved.get(days)).toEqual({ value: 30, source: "default" });
  });

  it("lists every declared key with its source, sorted by key", async () => {
    global('{"retention":{"days":7}}');
    const { settings } = makeSettings();
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.entries()).toEqual([
      { key: "retention.days", value: 7, source: "global" },
      { key: "worktree.branch_prefix", value: "spore", source: "default" },
    ]);
  });

  it("reads the files fresh on each call", async () => {
    const { settings, days } = makeSettings();
    global('{"retention":{"days":7}}');
    expect((await settings.resolve()).get(days).value).toBe(7);
    global('{"retention":{"days":9}}');
    expect((await settings.resolve()).get(days).value).toBe(9);
  });
});

async function expectError(
  promise: Promise<unknown>,
  code: string,
  ...mentions: string[]
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught as { status: number; code: string; message: string },
  );
  expect(error, "expected an error").toBeDefined();
  expect(error?.status).toBe(422);
  expect(error?.code).toBe(code);
  for (const text of mentions) expect(error?.message).toContain(text);
}

describe("bad files name the key and the file", () => {
  it("rejects a model key in the project file with 422 bad_project_config", async () => {
    projectFile('[agents.worker]\nmodel = "x"\n');
    const { settings } = makeSettings();
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "agents.worker.model",
      join(project, ".pi-spore", "config.toml"),
    );
  });

  it("rejects a model key in the local override", async () => {
    localFile('[worktree]\nthinking = "high"\n');
    const { settings } = makeSettings();
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "worktree.thinking",
      "config.local.toml",
    );
  });

  it("allows model keys in the global file", async () => {
    global('{"router":{"cloud":"a/b"}}');
    const { settings, days } = makeSettings();
    expect((await settings.resolve()).get(days).source).toBe("default");
  });

  it("rejects an unknown key in the project file", async () => {
    projectFile('[worktree]\nbranch_prefx = "x"\n');
    const { settings } = makeSettings();
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "worktree.branch_prefx",
      "config.toml",
    );
  });

  it("rejects an unknown section in the global file with 422 bad_settings", async () => {
    global('{"retenton":{"days":7}}');
    const { settings } = makeSettings();
    await expectError(settings.resolve(), "bad_settings", "retenton", "settings.json");
  });

  it("rejects a wrong type", async () => {
    global('{"retention":{"days":"7"}}');
    const { settings } = makeSettings();
    await expectError(settings.resolve(), "bad_settings", "retention.days", "settings.json");
  });

  it("rejects a section that must be a table", async () => {
    global('{"retention":7}');
    const { settings } = makeSettings();
    await expectError(settings.resolve(), "bad_settings", "retention", "settings.json");
  });

  it("rejects a global-only key in the project file", async () => {
    projectFile("[retention]\ndays = 3\n");
    const { settings } = makeSettings();
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "retention.days",
      "settings.json",
    );
  });

  it("rejects broken JSON and broken TOML", async () => {
    global("{not json");
    const { settings } = makeSettings();
    await expectError(settings.resolve(), "bad_settings", "not valid JSON");
    global("{}");
    projectFile("[worktree\n");
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "not valid TOML",
    );
  });

  it("leaves reserved sections to their owner", async () => {
    global('{"router":{"threshold":0.5}}');
    projectFile('[actions.test]\nrun = ["npm", "test"]\n');
    const { settings, days } = makeSettings();
    expect((await settings.resolve({ projectPath: project })).get(days).value).toBe(30);
  });
});

describe("raw files for modules that own a section", () => {
  it("gives the parsed project file and local override, and checks a section", async () => {
    projectFile('[actions.test]\nrun = ["npm", "test"]\n');
    const { settings } = makeSettings();
    const files = await settings.configFiles(project);
    expect(files.project?.data).toEqual({ actions: { test: { run: ["npm", "test"] } } });
    expect(files.local).toBeUndefined();
    expect(() =>
      settings.checkSection(Type.Object({ a: Type.Number() }), { a: "x" }, "somefile"),
    ).toThrowError(expect.objectContaining({ status: 422, code: "bad_project_config" }));
  });
});
