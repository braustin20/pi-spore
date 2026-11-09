import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerModule } from "@pi-spore/module-api";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettings } from "./settings.js";
import { createTestServer } from "./testing.js";

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

/** Call it first in a test: declaring ends here, and files written later are read as the test needs. */
async function makeSettings() {
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
  await settings.finishDeclaring();
  return { settings, prefix, days };
}

describe("resolve order (R17.2)", () => {
  it("uses the default when no file sets the key", async () => {
    const { settings, prefix } = await makeSettings();
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(prefix)).toEqual({ value: "spore", source: "default" });
  });

  it("lets the global file beat the default", async () => {
    const { settings, prefix } = await makeSettings();
    global('{"worktree":{"branch_prefix":"glob"}}');
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(prefix)).toEqual({ value: "glob", source: "global" });
  });

  it("lets the project file beat global", async () => {
    const { settings, prefix } = await makeSettings();
    global('{"worktree":{"branch_prefix":"glob"}}');
    projectFile('[worktree]\nbranch_prefix = "proj"\n');
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(prefix)).toEqual({ value: "proj", source: "project file" });
  });

  it("lets the local override beat the project file", async () => {
    const { settings, prefix } = await makeSettings();
    global('{"worktree":{"branch_prefix":"glob"}}');
    projectFile('[worktree]\nbranch_prefix = "proj"\n');
    localFile('[worktree]\nbranch_prefix = "loc"\n');
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(prefix)).toEqual({ value: "loc", source: "local override" });
  });

  it("puts a detected value above the default and below every file", async () => {
    const { settings, prefix } = await makeSettings();
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
    const { settings, prefix, days } = await makeSettings();
    projectFile('[worktree]\nbranch_prefix = "proj"\n');
    // An earlier call with a project must not leak into this one.
    await settings.resolve({ projectPath: project });
    const resolved = await settings.resolve();
    expect(resolved.get(prefix)).toEqual({ value: "spore", source: "default" });
    expect(resolved.get(days)).toEqual({ value: 30, source: "default" });
  });

  it("lists every declared key with its source, sorted by key", async () => {
    const { settings } = await makeSettings();
    global('{"retention":{"days":7}}');
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.entries()).toEqual([
      { key: "retention.days", value: 7, source: "global" },
      { key: "worktree.branch_prefix", value: "spore", source: "default" },
    ]);
  });

  it("reads the files fresh on each call", async () => {
    const { settings, days } = await makeSettings();
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
    const { settings } = await makeSettings();
    projectFile('[agents.worker]\nmodel = "x"\n');
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "agents.worker.model",
      join(project, ".pi-spore", "config.toml"),
    );
  });

  it("allows a model key in the local override, where a module declares one", async () => {
    const settings = createSettings(home);
    const model = settings.declare({
      key: "worker.model",
      schema: Type.String(),
      default: "none",
      scope: "project",
    });
    await settings.finishDeclaring();
    localFile('[worker]\nmodel = "a/b"\n');
    const resolved = await settings.resolve({ projectPath: project });
    expect(resolved.get(model)).toEqual({ value: "a/b", source: "local override" });
    // The committed file still never holds it.
    projectFile('[worker]\nmodel = "a/b"\n');
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "worker.model",
      "config.toml",
    );
  });

  it("does not let a quoted dotted key slip a model choice into the project file", async () => {
    const settings = createSettings(home);
    const model = settings.declare({
      key: "worker.model",
      schema: Type.String(),
      default: "none",
      scope: "project",
    });
    await settings.finishDeclaring();
    projectFile('"worker.model" = "a/b"\n');
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "worker.model",
      "config.toml",
    );
    // The same literal key is refused in the other files, so a dotted name never stands for a path.
    rmSync(join(project, ".pi-spore", "config.toml"));
    localFile('"worker.model" = "a/b"\n');
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "worker.model",
      "config.local.toml",
    );
    global('{"worker.model":"a/b"}');
    await expectError(settings.resolve(), "bad_settings", "worker.model", "settings.json");
    rmSync(join(project, ".pi-spore", "config.local.toml"));
    rmSync(join(home, "settings.json"));
    localFile('[worker]\nmodel = "a/b"\n');
    expect((await settings.resolve({ projectPath: project })).get(model).value).toBe("a/b");
  });

  it("treats an undeclared model key in the local override as an unknown key", async () => {
    const { settings } = await makeSettings();
    localFile('[agents.worker]\nmodel = "x"\n');
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      'unknown key "agents"',
      "config.local.toml",
    );
  });

  it("allows model keys in the global file", async () => {
    const { settings, days } = await makeSettings();
    global('{"router":{"model":"a/b"}}');
    expect((await settings.resolve()).get(days).source).toBe("default");
  });

  it("rejects an unknown key in the project file", async () => {
    const { settings } = await makeSettings();
    projectFile('[worktree]\nbranch_prefx = "x"\n');
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "worktree.branch_prefx",
      "config.toml",
    );
  });

  it("rejects an unknown section in the global file with 422 bad_settings", async () => {
    const { settings } = await makeSettings();
    global('{"retenton":{"days":7}}');
    await expectError(settings.resolve(), "bad_settings", "retenton", "settings.json");
  });

  it("rejects a wrong type", async () => {
    const { settings } = await makeSettings();
    global('{"retention":{"days":"7"}}');
    await expectError(settings.resolve(), "bad_settings", "retention.days", "settings.json");
  });

  it("rejects a section that must be a table", async () => {
    const { settings } = await makeSettings();
    global('{"retention":7}');
    await expectError(settings.resolve(), "bad_settings", "retention", "settings.json");
  });

  it("rejects a global-only key in the project file", async () => {
    const { settings } = await makeSettings();
    projectFile("[retention]\ndays = 3\n");
    await expectError(
      settings.resolve({ projectPath: project }),
      "bad_project_config",
      "retention.days",
      "settings.json",
    );
  });

  it("rejects broken JSON and broken TOML", async () => {
    const { settings } = await makeSettings();
    global("{not json");
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
    const { settings, days } = await makeSettings();
    global('{"router":{"threshold":0.5}}');
    projectFile('[actions.test]\nrun = ["npm", "test"]\n');
    expect((await settings.resolve({ projectPath: project })).get(days).value).toBe(30);
  });
});

describe("raw files for modules that own a section", () => {
  it("gives the parsed project file and local override, and checks a section", async () => {
    const { settings } = await makeSettings();
    projectFile('[actions.test]\nrun = ["npm", "test"]\n');
    const files = await settings.configFiles(project);
    expect(files.project?.data).toEqual({ actions: { test: { run: ["npm", "test"] } } });
    expect(files.local).toBeUndefined();
    expect(() =>
      settings.checkSection(Type.Object({ a: Type.Number() }), { a: "x" }, "somefile"),
    ).toThrowError(expect.objectContaining({ status: 422, code: "bad_project_config" }));
  });
});

describe("declaring ends after every module's setup", () => {
  it("lets a module resolve before a later module declares its key", async () => {
    global('{"early":{"a":1},"late":{"b":2}}');
    const settings = createSettings(home);
    const a = settings.declare({
      key: "early.a",
      schema: Type.Number(),
      default: 0,
      scope: "global",
    });
    expect((await settings.resolve()).get(a).value).toBe(1);
    const b = settings.declare({
      key: "late.b",
      schema: Type.Number(),
      default: 0,
      scope: "global",
    });
    await settings.finishDeclaring();
    expect((await settings.resolve()).get(b)).toEqual({ value: 2, source: "global" });
  });

  it("still rejects an unknown key once declaring ends", async () => {
    global('{"late":{"b":2}}');
    const settings = createSettings(home);
    settings.declare({ key: "early.a", schema: Type.Number(), default: 0, scope: "global" });
    await settings.resolve();
    await expectError(
      settings.finishDeclaring(),
      "bad_settings",
      'unknown key "late"',
      "settings.json",
    );
    await expectError(settings.resolve(), "bad_settings", 'unknown key "late"');
  });

  it("refuses a declaration after declaring ended", async () => {
    const settings = createSettings(home);
    await settings.finishDeclaring();
    expect(() =>
      settings.declare({ key: "late.b", schema: Type.Number(), default: 0, scope: "global" }),
    ).toThrowError(/late\.b/);
  });

  it("starts a server whose earlier module resolves before a later module declares", async () => {
    global('{"early":{"a":1},"late":{"b":2}}');
    let seen: unknown;
    const early: ServerModule = {
      id: "early",
      requires: [],
      core: true,
      async setup(host) {
        const a = host.settings.declare({
          key: "early.a",
          schema: Type.Number(),
          default: 0,
          scope: "global",
        });
        seen = (await host.settings.resolve()).get(a).value;
      },
    };
    const late: ServerModule = {
      id: "late",
      requires: ["early"],
      core: true,
      setup(host) {
        host.settings.declare({
          key: "late.b",
          schema: Type.Number(),
          default: 0,
          scope: "global",
        });
      },
    };
    const server = await createTestServer([early, late], { home });
    server.close();
    expect(seen).toBe(1);
  });

  it("fails startup on an unknown key, naming the key and the file", async () => {
    global('{"nope":{"b":2}}');
    const only: ServerModule = { id: "only", requires: [], core: true, setup: () => {} };
    await expect(createTestServer([only], { home })).rejects.toThrow(
      /settings\.json: unknown key "nope"/,
    );
  });
});
