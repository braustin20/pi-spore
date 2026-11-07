import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import {
  ActionList,
  ActionLog,
  ActionRun,
  ActionRunList,
  ArchiveWorkspaceResponse,
  CreateWorkspaceResponse,
  parse,
  type Workspace,
} from "@pi-spore/shared";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionsModule } from "./server.js";

const FIXTURE = fileURLToPath(new URL("../test-fixtures/action.mjs", import.meta.url));
const RunBody = Type.Object({ run: ActionRun });

let server: TestServer;
let scratch: string;

beforeEach(async () => {
  server = await createTestServer([
    projectsModule,
    vcsGitModule,
    vcsFolderModule,
    workspacesModule,
    actionsModule,
  ]);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-actions-")));
});
afterEach(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function json(response: Response, status = 200): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.status !== status) {
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function errorOf(response: Response, status: number) {
  return ((await json(response, status)) as { error: { code: string; message: string } }).error;
}

/** A TOML argv array that runs the fixture with these arguments. */
const fixture = (...args: string[]) => JSON.stringify([process.execPath, FIXTURE, ...args]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
}

/** A project folder with `.pi-spore/config.toml` (and the local override, if given). Git when `vcs` says so. */
function makeProject(config: string, options: { local?: string; git?: boolean } = {}): string {
  const dir = join(scratch, "project");
  mkdirSync(join(dir, ".pi-spore"), { recursive: true });
  writeFileSync(join(dir, ".pi-spore", "config.toml"), config);
  if (options.local) writeFileSync(join(dir, ".pi-spore", "config.local.toml"), options.local);
  if (options.git) {
    writeFileSync(join(dir, ".gitignore"), "marker.txt\n.pi-spore/config.local.toml\n");
    git(scratch, "init", "-q", "-b", "main", dir);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    // Gitignored, so only the copy list brings it into a new worktree.
    writeFileSync(join(dir, "marker.txt"), "copied");
  }
  return dir;
}

async function addProject(path: string): Promise<string> {
  const body = (await json(await server.request("POST", "/api/projects", { path }), 201)) as {
    project: { id: string };
  };
  return body.project.id;
}

async function createWorkspace(projectId: string, isolation = "in-place") {
  return parse(
    CreateWorkspaceResponse,
    await json(
      await server.request("POST", "/api/workspaces", { projectId, name: "Work", isolation }),
      201,
    ),
    "create workspace",
  );
}

async function inPlaceWorkspace(config: string, local?: string): Promise<Workspace> {
  const projectId = await addProject(makeProject(config, local ? { local } : {}));
  return (await createWorkspace(projectId)).workspace;
}

async function startRun(workspaceId: string, action: string): Promise<ActionRun> {
  const response = await server.request("POST", `/api/actions/workspaces/${workspaceId}/runs`, {
    action,
  });
  return parse(RunBody, await json(response, 201), "start run").run;
}

/** Waits for the run to end through the API's long poll. */
async function ended(runId: string): Promise<ActionRun> {
  const response = await server.request("GET", `/api/actions/runs/${runId}?wait=10000`);
  const run = parse(RunBody, await json(response), "run").run;
  if (run.status === "queued" || run.status === "running") throw new Error(`Run ${runId} hung`);
  return run;
}

async function getRun(runId: string): Promise<ActionRun> {
  return parse(RunBody, await json(await server.request("GET", `/api/actions/runs/${runId}`)), "r")
    .run;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("action config", () => {
  it("lists actions with their source; the local override replaces a whole action", async () => {
    const workspace = await inPlaceWorkspace(
      `[actions.test]\nrun = ["npm", "test"]\nexclusive = true\n\n[actions.dev]\nrun = "npm run dev"\nshell = true\ndescription = "Dev server"\n`,
      `[actions.test]\nrun = ["npm", "run", "test:fast"]\n`,
    );
    const body = parse(
      ActionList,
      await json(await server.request("GET", `/api/actions/workspaces/${workspace.id}`)),
      "actions",
    );
    expect(body.actions).toEqual([
      {
        name: "dev",
        run: "npm run dev",
        shell: true,
        exclusive: false,
        description: "Dev server",
        source: "project file",
      },
      {
        name: "test",
        run: ["npm", "run", "test:fast"],
        shell: false,
        exclusive: false,
        source: "local override",
      },
    ]);
  });

  it.each([
    ['[actions.dev]\nrun = "npm run dev"\n', "needs shell = true"],
    ['[actions.dev]\nrun = ["npm"]\nshell = true\n', 'needs "run" as one string'],
    ['[actions.dev]\nrun = ["npm"]\ncwd = "x"\n', "Invalid"],
    ["[actions.dev]\nrun = []\n", "Invalid"],
    ['[actions.Dev]\nrun = ["npm"]\n', "names use lowercase"],
    ['[actions.dev]\nrun = ["pi"]\nmodel = "x"\n', 'sets "actions.dev.model"'],
  ])("rejects a bad action: %j", async (config, message) => {
    // Written after the workspace exists: a model key also stops workspace creation.
    const workspace = await inPlaceWorkspace("");
    writeFileSync(join(workspace.path, ".pi-spore", "config.toml"), config);
    const error = await errorOf(
      await server.request("GET", `/api/actions/workspaces/${workspace.id}`),
      422,
    );
    expect(error.code).toBe("bad_project_config");
    expect(error.message).toContain(message);
  });
});

describe("action runs", () => {
  it("runs an argv action in the workspace folder with the workspace env and keeps its log", async () => {
    const out = join(scratch, "env.json");
    const workspace = await inPlaceWorkspace(
      `[actions.check]\nrun = ${fixture("env", out)}\n\n[actions.say]\nrun = ${fixture("say", "héllo")}\n`,
    );

    const started = await startRun(workspace.id, "check");
    expect(started).toMatchObject({ action: "check", trigger: "user" });
    const run = await ended(started.id);

    expect(run).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(run.logPath).toBe(join(server.paths.logs, "actions", workspace.id, `${started.id}.log`));
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      cwd: workspace.path,
      env: {
        PI_SPORE_WORKSPACE_ID: workspace.id,
        PI_SPORE_WORKSPACE_PATH: workspace.path,
        PI_SPORE_PROJECT_ROOT: workspace.path,
      },
      marker: false,
    });

    const say = await ended((await startRun(workspace.id, "say")).id);
    const log = parse(
      ActionLog,
      await json(await server.request("GET", `/api/actions/runs/${say.id}/log`)),
      "log",
    );
    expect(log.text).toContain("héllo\n");
    expect(log.text).toContain("err:héllo\n");
    expect(log.text.startsWith("$ ")).toBe(true);
    expect(log.end).toBe(log.size);

    const runs = parse(
      ActionRunList,
      await json(await server.request("GET", `/api/actions/workspaces/${workspace.id}/runs`)),
      "runs",
    );
    expect(runs.runs.map((entry) => entry.action)).toEqual(["say", "check"]);
  });

  it("runs a shell action only when it says shell = true", async () => {
    const workspace = await inPlaceWorkspace(
      '[actions.write]\nrun = "echo \\"$PI_SPORE_WORKSPACE_ID\\" > out.txt"\nshell = true\n',
    );
    const run = await ended((await startRun(workspace.id, "write")).id);
    expect(run.status).toBe("succeeded");
    expect(readFileSync(join(workspace.path, "out.txt"), "utf8")).toBe(`${workspace.id}\n`);
  });

  it("records the exit code of a failed run and the error of a missing program", async () => {
    const workspace = await inPlaceWorkspace(
      `[actions.fail]\nrun = ${fixture("fail", "3")}\n\n[actions.missing]\nrun = ["${join(scratch, "no-such-program")}"]\n`,
    );
    expect(await ended((await startRun(workspace.id, "fail")).id)).toMatchObject({
      status: "failed",
      exitCode: 3,
    });
    const missing = await ended((await startRun(workspace.id, "missing")).id);
    expect(missing.status).toBe("failed");
    expect(missing.error).toContain("ENOENT");
  });

  it("cancels a run together with the programs it started", async () => {
    const pidFile = join(scratch, "child.pid");
    const workspace = await inPlaceWorkspace(
      `[actions.family]\nrun = ${fixture("family", pidFile)}\n`,
    );
    const run = await startRun(workspace.id, "family");
    // Following the log until "started" shows the run is up.
    let from = 0;
    let text = "";
    while (!text.includes("started")) {
      const log = parse(
        ActionLog,
        await json(
          await server.request("GET", `/api/actions/runs/${run.id}/log?from=${from}&wait=10000`),
        ),
        "log",
      );
      text += log.text;
      from = log.end;
    }
    const child = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(child)).toBe(true);

    await json(await server.request("POST", `/api/actions/runs/${run.id}/cancel`));
    expect((await ended(run.id)).status).toBe("cancelled");
    await vi.waitFor(() => expect(isAlive(child)).toBe(false));
  });

  it("queues exclusive runs per folder and starts the next when one ends", async () => {
    const workspace = await inPlaceWorkspace(
      `[actions.long]\nrun = ${fixture("hang")}\nexclusive = true\n\n[actions.next]\nrun = ${fixture("say", "next")}\nexclusive = true\n\n[actions.free]\nrun = ${fixture("say", "free")}\n`,
    );
    const long = await startRun(workspace.id, "long");
    const next = await startRun(workspace.id, "next");
    const dropped = await startRun(workspace.id, "next");
    expect(long.status).toBe("running");
    expect(next.status).toBe("queued");

    // Non-exclusive actions do not wait.
    expect((await ended((await startRun(workspace.id, "free")).id)).status).toBe("succeeded");
    expect((await getRun(next.id)).status).toBe("queued");

    await json(await server.request("POST", `/api/actions/runs/${dropped.id}/cancel`));
    expect((await getRun(dropped.id)).status).toBe("cancelled");
    await json(await server.request("POST", `/api/actions/runs/${long.id}/cancel`));
    expect((await ended(long.id)).status).toBe("cancelled");
    expect((await ended(next.id)).status).toBe("succeeded");
    expect((await getRun(dropped.id)).startedAt).toBeUndefined();
  });

  it("refuses unknown actions, parked workspaces, bad bodies, and bad query values", async () => {
    const workspace = await inPlaceWorkspace(`[actions.say]\nrun = ${fixture("say", "x")}\n`);
    const base = `/api/actions/workspaces/${workspace.id}/runs`;
    expect((await errorOf(await server.request("POST", base, { action: "nope" }), 404)).code).toBe(
      "action_not_found",
    );
    expect(
      (
        await server.request("POST", base, undefined, {
          "content-type": "application/json",
        })
      ).status,
    ).toBe(400);
    const run = await startRun(workspace.id, "say");
    expect(
      (await errorOf(await server.request("GET", `/api/actions/runs/${run.id}/log?from=-1`), 400))
        .code,
    ).toBe("bad_query");
    await ended(run.id);
    await json(await server.request("POST", `/api/workspaces/${workspace.id}/park`));
    expect((await errorOf(await server.request("POST", base, { action: "say" }), 409)).code).toBe(
      "workspace_not_active",
    );
  });
});

describe("setup and teardown", () => {
  it("runs setup in a new copy after the copy list, and reports it", async () => {
    const out = join(scratch, "setup.json");
    const repo = makeProject(
      `[worktree]\ncopy = ["marker.txt"]\n\n[actions.setup]\nrun = ${fixture("env", out)}\n`,
      { git: true },
    );
    const { workspace, steps } = await createWorkspace(await addProject(repo), "new");

    expect(steps).toEqual([
      expect.objectContaining({ name: "setup", ok: true, message: "setup succeeded" }),
    ]);
    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen).toMatchObject({ cwd: workspace.path, marker: true });
    expect(seen.env).toEqual({
      PI_SPORE_WORKSPACE_ID: workspace.id,
      PI_SPORE_WORKSPACE_PATH: workspace.path,
      PI_SPORE_PROJECT_ROOT: repo,
    });
    const runs = parse(
      ActionRunList,
      await json(await server.request("GET", `/api/actions/workspaces/${workspace.id}/runs`)),
      "runs",
    ).runs;
    expect(runs).toEqual([expect.objectContaining({ action: "setup", trigger: "create" })]);
  });

  it("keeps the workspace when setup fails and says where the log is", async () => {
    const repo = makeProject(`[actions.setup]\nrun = ${fixture("fail", "2")}\n`, { git: true });
    const { workspace, steps } = await createWorkspace(await addProject(repo), "new");

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ name: "setup", ok: false });
    expect(steps[0]?.message).toContain("setup failed with exit code 2; log: ");
    expect(readFileSync(steps[0]?.logPath as string, "utf8")).toContain("failing");
    expect(existsSync(workspace.path)).toBe(true);
    await json(await server.request("GET", `/api/workspaces/${workspace.id}`));
  });

  it("does not run setup for a workspace in the main checkout", async () => {
    const out = join(scratch, "setup.json");
    const repo = makeProject(`[actions.setup]\nrun = ${fixture("env", out)}\n`, { git: true });
    const { steps } = await createWorkspace(await addProject(repo), "in-place");
    expect(steps).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it("runs teardown before the copy is removed", async () => {
    const out = join(scratch, "teardown.json");
    const repo = makeProject(
      `[worktree]\ncopy = ["marker.txt"]\n\n[actions.teardown]\nrun = ${fixture("env", out)}\n`,
      { git: true },
    );
    const { workspace } = await createWorkspace(await addProject(repo), "new");

    const body = parse(
      ArchiveWorkspaceResponse,
      await json(await server.request("POST", `/api/workspaces/${workspace.id}/archive`, {})),
      "archive",
    );
    expect(body.steps).toEqual([expect.objectContaining({ name: "teardown", ok: true })]);
    // The copy (with its copied marker) was still there when teardown ran.
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      cwd: workspace.path,
      marker: true,
    });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it("blocks archive when teardown fails, unless forced", async () => {
    const repo = makeProject(`[actions.teardown]\nrun = ${fixture("fail", "4")}\n`, { git: true });
    const { workspace } = await createWorkspace(await addProject(repo), "new");
    const archive = (body: unknown) =>
      server.request("POST", `/api/workspaces/${workspace.id}/archive`, body);

    const error = await errorOf(await archive({}), 409);
    expect(error.code).toBe("teardown_failed");
    expect(error.message).toContain("exit code 4");
    expect(existsSync(workspace.path)).toBe(true);

    const forced = parse(ArchiveWorkspaceResponse, await json(await archive({ force: true })), "a");
    expect(forced.workspace.state).toBe("archived");
    expect(forced.steps).toEqual([expect.objectContaining({ name: "teardown", ok: false })]);
    expect(existsSync(workspace.path)).toBe(false);
  });

  it("cancels running actions before a workspace is archived", async () => {
    const repo = makeProject(`[actions.long]\nrun = ${fixture("hang")}\n`, { git: true });
    const { workspace } = await createWorkspace(await addProject(repo), "new");
    const run = await startRun(workspace.id, "long");

    await json(await server.request("POST", `/api/workspaces/${workspace.id}/archive`, {}));
    expect((await getRun(run.id)).status).toBe("cancelled");
  });
});
