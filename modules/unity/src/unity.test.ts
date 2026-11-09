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
import { actionsModule } from "@pi-spore/mod-actions/server";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import {
  type ActionRun,
  ApprovalList,
  CreateWorkspaceResponse,
  OpenUnityResponse,
  parse,
  UnityWorkspaceView,
  type Workspace,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type UnityEditors, UnityEditorsKey } from "./contract.js";
import { type ProcessInfo, parseStatus } from "./editors.js";
import { createUnityModule } from "./server.js";

const FAKE_UNITY = fileURLToPath(new URL("../test-fixtures/fake-unity.mjs", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let server: TestServer;
let agents: ReturnType<typeof createAgentsModule>;
/** The editor lease as another module sees it, for tests that act as an agent. */
let editors: UnityEditors;
/** Runs in the gate's wait loop instead of a real pause, so a test decides what happens while it waits. */
let onSleep: () => Promise<void>;
/** The process-side deadline of a test gate; unset means the module's default. */
let testDeadlineMs: number | undefined;
let scratch: string;
let stateFile: string;
/** What the fake process list shows; tests add Unity processes here. */
let processes: ProcessInfo[] | undefined;

interface FakeState {
  instances: { projectPath: string; pid: number; state: string }[];
  calls: string[][];
  openFails?: boolean;
  closeFails?: boolean | string;
  pipelineMissing?: boolean;
  testFails?: boolean;
  noReport?: boolean;
  testHangs?: boolean;
}
const readState = (): FakeState => JSON.parse(readFileSync(stateFile, "utf8"));
const writeState = (change: Partial<FakeState>) =>
  writeFileSync(stateFile, JSON.stringify({ ...readState(), ...change }));
/** The subcommands the fake CLI was called with, without `status`. */
const actions = () =>
  readState()
    .calls.filter((call) => call[0] !== "status")
    .map((call) => call.filter((arg) => !arg.startsWith("--")).join(" "));

const probe: ServerModule = {
  id: "unity-probe",
  requires: ["unity"],
  core: false,
  setup(host) {
    editors = host.use(UnityEditorsKey);
  },
};

async function start(unityCommand = process.execPath) {
  agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
    idleStopMs: 60_000,
    startTimeoutMs: 5_000,
  });
  server = await createTestServer([
    projectsModule,
    vcsGitModule,
    workspacesModule,
    artifactsModule,
    agents,
    actionsModule,
    attentionModule,
    createUnityModule({
      unity: { command: unityCommand, args: [FAKE_UNITY, stateFile] },
      processes: async () => processes,
      sleep: async () => onSleep(),
      reportDir: scratch,
      ...(testDeadlineMs === undefined ? {} : { testDeadlineMs }),
    }),
    probe,
  ]);
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-unity-")));
  stateFile = join(scratch, "unity-state.json");
  writeFileSync(stateFile, JSON.stringify({ instances: [], calls: [] }));
  processes = [];
  testDeadlineMs = undefined;
  onSleep = async () => {
    throw new Error("The gate waited, but this test did not expect it to");
  };
  await start();
});
afterEach(async () => {
  await agents.manager().stopAll();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
  });
}

function makeRepo(name: string, unity = true): string {
  const repo = join(scratch, name);
  mkdirSync(join(repo, "ProjectSettings"), { recursive: true });
  if (unity)
    writeFileSync(
      join(repo, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.3.10f1\n",
    );
  writeFileSync(join(repo, ".gitignore"), "Library/\nTemp/\n");
  writeFileSync(join(repo, "README.md"), "game\n");
  git(scratch, "init", "-q", "-b", "main", repo);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function json(response: Response, status = 200): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
const errorOf = async (response: Response, status: number) =>
  ((await json(response, status)) as { error: { code: string; message: string } }).error;

/** A Unity project with two worktree workspaces. */
async function setup(unity = true) {
  const repo = makeRepo("game", unity);
  const { project } = (await json(
    await server.request("POST", "/api/projects", { path: repo }),
    201,
  )) as { project: { id: string } };
  const create = async (name: string): Promise<Workspace> =>
    parse(
      CreateWorkspaceResponse,
      await json(
        await server.request("POST", "/api/workspaces", {
          projectId: project.id,
          name,
          isolation: "new",
        }),
        201,
      ),
      "create",
    ).workspace;
  return { repo, projectId: project.id, a: await create("A"), b: await create("B") };
}

const view = async (workspace: Workspace) =>
  parse(
    UnityWorkspaceView,
    await json(await server.request("GET", `/api/unity/workspaces/${workspace.id}`)),
    "unity view",
  );
const open = (workspace: Workspace) =>
  server.request("POST", `/api/unity/workspaces/${workspace.id}/open`);
const close = (body: unknown) => server.request("POST", "/api/unity/editors/close", body);

describe("Open in Unity", () => {
  it("says a workspace of another kind of project has no Unity", async () => {
    const { a } = await setup(false);
    expect(await view(a)).toEqual({ unity: false });
    expect((await errorOf(await open(a), 422)).code).toBe("not_unity");
  });

  it("opens the workspace folder and gives the lease to the user", async () => {
    const { a, projectId } = await setup();
    const opened = parse(OpenUnityResponse, await json(await open(a)), "open");

    expect(opened).toMatchObject({
      alreadyOpen: false,
      lease: { projectId, path: a.path, workspaceId: a.id, owner: "user" },
    });
    expect(actions()).toEqual([`open ${a.path}`]);
    const shown = await view(a);
    expect(shown).toMatchObject({ unity: true, editorVersion: "6000.3.10f1" });
    if (!shown.unity) throw new Error("not unity");
    expect(shown.editors.editors).toEqual([
      {
        path: a.path,
        workspaceId: a.id,
        pid: 4242,
        state: "ready",
        seenBy: ["status", "lockfile"],
      },
    ]);
    expect(shown.editors.lease?.seenAt).toBeDefined();

    // Asking again does not start a second editor.
    expect(parse(OpenUnityResponse, await json(await open(a)), "again").alreadyOpen).toBe(true);
    expect(actions()).toEqual([`open ${a.path}`]);
  });

  it("refuses to open a second worktree and never closes the first by itself", async () => {
    const { a, b } = await setup();
    await json(await open(a));

    const error = await errorOf(await open(b), 409);
    expect(error.code).toBe("editor_open");
    expect(error.message).toContain(a.path);
    expect(actions()).toEqual([`open ${a.path}`]);
  });

  it("closes an editor only with an explicit yes, then opens the other worktree", async () => {
    const { a, b, projectId } = await setup();
    await json(await open(a));

    expect((await close({ projectId, path: a.path })).status).toBe(400);
    expect((await close({ projectId, path: a.path, confirm: false })).status).toBe(400);
    expect(actions()).toEqual([`open ${a.path}`]);

    await json(await close({ projectId, path: a.path, confirm: true }));
    expect(actions()).toEqual([`open ${a.path}`, `close ${a.path}`]);
    await json(await open(b));
    expect(actions().at(-1)).toBe(`open ${b.path}`);
  });

  it("reports a close the editor refused, and keeps the lease", async () => {
    const { a, projectId } = await setup();
    await json(await open(a));
    writeState({ closeFails: true });

    const error = await errorOf(await close({ projectId, path: a.path, confirm: true }), 409);
    expect(error.code).toBe("close_failed");
    expect(error.message).toContain("No graceful channel");
    const shown = await view(a);
    expect(shown.unity && shown.editors.lease?.path).toBe(a.path);
  });

  it("sees an editor without the Pipeline package by its process, and the main checkout's editor", async () => {
    const { repo, a } = await setup();
    // Unity has the main checkout open: no `unity status` row, but a process and a lock file.
    processes = [{ pid: 99, argv: ["/opt/Unity/Editor/Unity", "-projectpath", `${repo}/`] }];
    mkdirSync(join(repo, "Temp"));
    writeFileSync(join(repo, "Temp", "UnityLockfile"), "");

    const shown = await view(a);
    expect(shown.unity && shown.editors.editors).toEqual([
      { path: repo, pid: 99, seenBy: ["process", "lockfile"] },
    ]);
    const error = await errorOf(await open(a), 409);
    expect(error.message).toContain(`the main checkout ${repo}`);
  });

  it("treats a lock file with no editor behind it as stale, and it does not block", async () => {
    const { a, b } = await setup();
    mkdirSync(join(b.path, "Temp"), { recursive: true });
    writeFileSync(join(b.path, "Temp", "UnityLockfile"), "");

    const shown = await view(a);
    expect(shown.unity && shown.editors).toMatchObject({ editors: [], staleLocks: [b.path] });
    await json(await open(a));
  });

  it("counts a lock file as an open editor where processes cannot be listed", async () => {
    const { a, b } = await setup();
    processes = undefined;
    mkdirSync(join(b.path, "Temp"), { recursive: true });
    writeFileSync(join(b.path, "Temp", "UnityLockfile"), "");

    expect((await errorOf(await open(a), 409)).code).toBe("editor_open");
  });

  it("drops the lease when the editor was closed outside pi-spore", async () => {
    const { a, b } = await setup();
    await json(await open(a));
    await view(a);
    // The user quits Unity by hand.
    writeState({ instances: [] });
    rmSync(join(a.path, "Temp"), { recursive: true });

    const shown = await view(a);
    expect(shown.unity && shown.editors).toMatchObject({ editors: [], staleLocks: [] });
    expect(shown.unity && shown.editors.lease).toBeUndefined();
    await json(await open(b));
  });

  it("keeps a starting editor's lease so a second open waits for it", async () => {
    const { a, b } = await setup();
    await json(await open(a));
    // Unity has not written its lock file or answered status yet.
    writeState({ instances: [] });
    rmSync(join(a.path, "Temp"), { recursive: true });

    const shown = await view(b);
    expect(shown.unity && shown.editors.editors).toEqual([
      { path: a.path, workspaceId: a.id, state: "starting", seenBy: ["lease"] },
    ]);
    expect((await errorOf(await open(b), 409)).code).toBe("editor_open");
  });

  it("passes on the error when unity open fails, and keeps no lease", async () => {
    const { a } = await setup();
    writeState({ openFails: true });
    const failed = await errorOf(await open(a), 503);
    expect(failed.code).toBe("unity_open_failed");
    expect(failed.message).toContain("not installed");
    const shown = await view(a);
    expect(shown.unity && shown.editors.lease).toBeUndefined();
  });

  it("names the unity CLI when it cannot run", async () => {
    server.close();
    await start(join(scratch, "no-such-unity"));
    const { a } = await setup();
    const missing = await errorOf(await open(a), 503);
    expect(missing.code).toBe("unity_cli_failed");
    expect(missing.message).toContain("no-such-unity");
  });

  it("refuses to archive a worktree while Unity has it open, even when forced", async () => {
    const { a, projectId } = await setup();
    await json(await open(a));

    const error = await errorOf(
      await server.request("POST", `/api/workspaces/${a.id}/archive`, { force: true }),
      409,
    );
    expect(error.code).toBe("editor_open");
    expect(existsSync(a.path)).toBe(true);

    await json(await close({ projectId, path: a.path, confirm: true }));
    await json(await server.request("POST", `/api/workspaces/${a.id}/archive`, {}));
    expect(existsSync(a.path)).toBe(false);
  });
});

describe("close without the Pipeline package (Q17)", () => {
  it("falls back to --force when plain close says the package is missing", async () => {
    const { a, projectId } = await setup();
    await json(await open(a));
    writeState({ pipelineMissing: true });

    await json(await close({ projectId, path: a.path, confirm: true }));
    const closes = readState().calls.filter((call) => call[0] === "close");
    expect(closes.map((call) => call.includes("--force"))).toEqual([false, true]);
    expect(readState().instances).toEqual([]);
  });

  it("does not force a close that failed for another reason, even if the output names the code", async () => {
    const { a, projectId } = await setup();
    await json(await open(a));
    writeState({ closeFails: "Cannot talk to the editor (not PROJECTS_CLOSE_PIPELINE_MISSING)" });

    expect((await errorOf(await close({ projectId, path: a.path, confirm: true }), 409)).code).toBe(
      "close_failed",
    );
    const closes = readState().calls.filter((call) => call[0] === "close");
    expect(closes.map((call) => call.includes("--force"))).toEqual([false]);
  });

  it("does not force a close when the CLI prints no JSON error", async () => {
    const { a, projectId } = await setup();
    await json(await open(a));
    writeState({ closeFails: "{PROJECTS_CLOSE_PIPELINE_MISSING" });

    await errorOf(await close({ projectId, path: a.path, confirm: true }), 409);
    expect(readState().calls.filter((call) => call.includes("--force"))).toEqual([]);
  });
});

describe("Unity test gates (R10.6)", () => {
  const startGate = async (workspace: Workspace, action = "unity-test-editmode") => {
    const { run } = (await json(
      await server.request("POST", `/api/actions/workspaces/${workspace.id}/runs`, { action }),
      201,
    )) as { run: ActionRun };
    return run;
  };
  const ended = async (id: string): Promise<ActionRun> => {
    for (let tries = 0; tries < 20; tries++) {
      const { run } = (await json(
        await server.request("GET", `/api/actions/runs/${id}?wait=1000`),
      )) as { run: ActionRun };
      if (!["queued", "running"].includes(run.status)) return run;
    }
    throw new Error(`Run ${id} did not end`);
  };
  const logOf = async (id: string) =>
    ((await json(await server.request("GET", `/api/actions/runs/${id}/log`))) as { text: string })
      .text;
  const report = async (workspace: Workspace, id: string) =>
    server.request(
      "GET",
      `/api/artifacts/workspaces/${workspace.id}/file?path=unity-tests/${id}.xml`,
    );
  /** The commands the gate ran, each as `<subcommand> <path>`. */
  const steps = () => actions().map((step) => step.split(" ").slice(0, 2).join(" "));
  const testCalls = () => readState().calls.filter((call) => call[0] === "test");
  const openApprovals = async () =>
    parse(
      ApprovalList,
      await json(await server.request("GET", "/api/attention/approvals?state=open")),
      "approvals",
    ).approvals;
  /** The user quits Unity by hand. */
  const quitUnity = (workspace: Workspace) => {
    writeState({ instances: [] });
    rmSync(join(workspace.path, "Temp"), { recursive: true, force: true });
  };

  it("offers EditMode and PlayMode gates for Unity projects", async () => {
    const { a } = await setup();
    const listed = (await json(await server.request("GET", `/api/actions/workspaces/${a.id}`))) as {
      actions: { name: string }[];
    };
    expect(listed.actions.map((action) => action.name)).toEqual([
      "unity-test-editmode",
      "unity-test-playmode",
    ]);
  });

  it("offers no Unity gates for other projects", async () => {
    const { a } = await setup(false);
    const listed = (await json(await server.request("GET", `/api/actions/workspaces/${a.id}`))) as {
      actions: unknown[];
    };
    expect(listed.actions).toEqual([]);
  });

  it("runs the tests in batch mode and keeps the report as an artifact", async () => {
    const { a } = await setup();
    const run = await ended((await startGate(a)).id);

    expect(run.status).toBe("succeeded");
    expect(testCalls()).toHaveLength(1);
    expect(testCalls()[0]?.slice(0, 4)).toEqual(["test", a.path, "--mode", "EditMode"]);
    const stored = await report(a, run.id);
    expect(await stored.text()).toContain('passed="3"');
    const shown = await view(a);
    expect(shown.unity && shown.tests).toMatchObject([
      { runId: run.id, mode: "EditMode", status: "succeeded", report: `unity-tests/${run.id}.xml` },
    ]);
  });

  it("runs PlayMode with its own mode", async () => {
    const { a } = await setup();
    const run = await ended((await startGate(a, "unity-test-playmode")).id);
    expect(run.status).toBe("succeeded");
    expect(testCalls()[0]?.slice(2, 4)).toEqual(["--mode", "PlayMode"]);
  });

  it("fails with the log tail and keeps the report when tests fail", async () => {
    const { a } = await setup();
    writeState({ testFails: true });
    const run = await ended((await startGate(a)).id);

    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(1);
    expect(await logOf(run.id)).toContain("Failed: Calculator.Add_Negative");
    expect(await (await report(a, run.id)).text()).toContain('failed="1"');
  });

  it("fails loudly when unity exits 0 without a report", async () => {
    const { a } = await setup();
    writeState({ noReport: true });
    const run = await ended((await startGate(a)).id);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("no report");
  });

  it("waits while an agent holds the editor, then runs without closing anything", async () => {
    const { a } = await setup();
    await editors.open(a.id, "agent");
    let waits = 0;
    onSleep = async () => {
      waits++;
      expect(testCalls()).toHaveLength(0);
      quitUnity(a);
    };

    const run = await ended((await startGate(a)).id);
    expect(run.status).toBe("succeeded");
    expect(waits).toBe(1);
    expect(steps()).toEqual([`open ${a.path}`, `test ${a.path}`]);
    expect(await openApprovals()).toEqual([]);
  });

  it("asks on Home before it closes the user's editor, and closes after the yes", async () => {
    const { a } = await setup();
    await json(await open(a));
    writeState({ pipelineMissing: true });
    onSleep = async () => {
      const [approval] = await openApprovals();
      expect(approval).toMatchObject({ kind: "unity-close-editor", workspaceId: a.id });
      expect(approval?.reason).toContain("without saving");
      // Nothing was closed or tested before the yes.
      expect(steps()).toEqual([`open ${a.path}`]);
      await json(
        await server.request("POST", `/api/attention/approvals/${approval?.id}/approve`, {}),
      );
      onSleep = async () => {
        throw new Error("The gate kept waiting after the editor closed");
      };
    };

    const run = await ended((await startGate(a)).id);
    expect(run.status).toBe("succeeded");
    expect(steps()).toEqual([
      `open ${a.path}`,
      `close ${a.path}`,
      `close ${a.path}`,
      `test ${a.path}`,
    ]);
    expect(await openApprovals()).toEqual([]);
  });

  it("fails and never closes the editor when the user declines", async () => {
    const { a } = await setup();
    await json(await open(a));
    onSleep = async () => {
      const [approval] = await openApprovals();
      await json(
        await server.request("POST", `/api/attention/approvals/${approval?.id}/decline`, {}),
      );
    };

    const run = await ended((await startGate(a)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("declined");
    expect(steps()).toEqual([`open ${a.path}`]);
  });

  it("starts when the user quits Unity while the approval is open", async () => {
    const { a } = await setup();
    await json(await open(a));
    onSleep = async () => quitUnity(a);

    const run = await ended((await startGate(a)).id);
    expect(run.status).toBe("succeeded");
    expect(steps()).toEqual([`open ${a.path}`, `test ${a.path}`]);
  });

  it("fails the run, and does not crash, when the unity program does not exist", async () => {
    server.close();
    await start(join(scratch, "no-such-unity"));
    const { a } = await setup();
    const run = await ended((await startGate(a)).id);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("no-such-unity");
    // Give a stray close handler time to throw; vitest fails the file on an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("does not close an editor an agent took over after the user's approval was filed", async () => {
    const { a } = await setup();
    await json(await open(a));
    onSleep = async () => {
      const [approval] = await openApprovals();
      // The user quits Unity, then an agent opens the same folder before the gate looks again.
      quitUnity(a);
      await editors.open(a.id, "agent");
      const decided = (await json(
        await server.request("POST", `/api/attention/approvals/${approval?.id}/approve`, {}),
      )) as { approval: { outcome: string } };
      expect(decided.approval.outcome).toContain("agent");
      expect(steps()).toEqual([`open ${a.path}`, `open ${a.path}`]);
      onSleep = async () => quitUnity(a);
    };

    const run = await ended((await startGate(a)).id);
    expect(run.status).toBe("succeeded");
    expect(steps()).toEqual([`open ${a.path}`, `open ${a.path}`, `test ${a.path}`]);
  });

  it("shows the latest gate runs even after many other action runs", async () => {
    const { repo, a } = await setup();
    const gate = await ended((await startGate(a)).id);
    mkdirSync(join(repo, ".pi-spore"));
    writeFileSync(join(repo, ".pi-spore", "config.toml"), '[actions.noop]\nrun = ["true"]\n');
    const noise = await Promise.all(Array.from({ length: 51 }, () => startGate(a, "noop")));
    for (const run of noise) await ended(run.id);

    const shown = await view(a);
    expect(shown.unity && shown.tests.map((test) => test.runId)).toEqual([gate.id]);
  });

  /** Waits until the run's log shows that `unity test` has started. */
  const untilTestRuns = async (id: string) => {
    let from = 0;
    for (let tries = 0; tries < 20; tries++) {
      const log = (await json(
        await server.request("GET", `/api/actions/runs/${id}/log?from=${from}&wait=1000`),
      )) as { text: string; end: number };
      if (log.text.includes("Running ")) return;
      from = log.end;
    }
    throw new Error("unity test did not start");
  };
  const leftover = (id: string) => existsSync(join(scratch, `pi-spore-unity-report-${id}.xml`));

  it("asks again when the user reopens Unity after an approval that closed nothing", async () => {
    const { a } = await setup();
    await json(await open(a));
    let looks = 0;
    onSleep = async () => {
      looks++;
      const [first] = await openApprovals();
      if (looks === 1) {
        // The user quits Unity, approves the old question, then opens Unity again.
        quitUnity(a);
        await json(
          await server.request("POST", `/api/attention/approvals/${first?.id}/approve`, {}),
        );
        await json(await open(a));
        return;
      }
      // The first question is answered; this is a new one.
      expect(first).toBeDefined();
      await json(await server.request("POST", `/api/attention/approvals/${first?.id}/approve`, {}));
    };

    const run = await ended((await startGate(a)).id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("succeeded");
    expect(looks).toBe(2);
    expect(steps().filter((step) => step.startsWith("close"))).toHaveLength(1);
  });

  it("refuses an approve whose subject names another folder than the gate asked about", async () => {
    const { repo, a, projectId } = await setup();
    await json(await open(a));
    onSleep = async () => {
      const [approval] = await openApprovals();
      writeState({
        instances: [...readState().instances, { projectPath: repo, pid: 9, state: "ready" }],
      });
      const refused = await server.request(
        "POST",
        `/api/attention/approvals/${approval?.id}/approve`,
        {
          subject: { projectId, path: repo },
        },
      );
      expect(refused.status).toBe(422);
      expect(steps().some((step) => step.startsWith("close"))).toBe(false);
      expect(await openApprovals()).toHaveLength(1);
      quitUnity(a);
    };

    const run = await ended((await startGate(a)).id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("succeeded");
  });

  it("asks only once for the same folder when an earlier gate was cancelled", async () => {
    const { a } = await setup();
    await json(await open(a));
    const first = await startGate(a);
    let asked: string | undefined;
    onSleep = async () => {
      asked = (await openApprovals())[0]?.id;
      await json(await server.request("POST", `/api/actions/runs/${first.id}/cancel`));
    };
    expect((await ended(first.id)).status).toBe("cancelled");

    onSleep = async () => {
      expect((await openApprovals()).map((approval) => approval.id)).toEqual([asked]);
      quitUnity(a);
    };
    const second = await ended((await startGate(a)).id);
    expect(second.error).toBeUndefined();
    expect(second.status).toBe("succeeded");
  });

  it("stops a unity test that never ends, fails the gate, and removes its report file", async () => {
    server.close();
    testDeadlineMs = 300;
    await start();
    const { a } = await setup();
    writeState({ testHangs: true });
    const started = await startGate(a);
    const run = await ended(started.id);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Timed out");
    expect(leftover(started.id)).toBe(false);
  });

  it("removes the report file when the run is cancelled", async () => {
    const { a } = await setup();
    writeState({ testHangs: true });
    const started = await startGate(a);
    await untilTestRuns(started.id);
    expect(leftover(started.id)).toBe(true);
    await json(await server.request("POST", `/api/actions/runs/${started.id}/cancel`));

    expect((await ended(started.id)).status).toBe("cancelled");
    expect(leftover(started.id)).toBe(false);
  });

  it("stops waiting when the run is cancelled", async () => {
    const { a } = await setup();
    await editors.open(a.id, "agent");
    const started = await startGate(a);
    onSleep = async () => {
      await json(await server.request("POST", `/api/actions/runs/${started.id}/cancel`));
    };

    const run = await ended(started.id);
    expect(run.status).toBe("cancelled");
    expect(testCalls()).toHaveLength(0);
  });
});

describe("parseStatus", () => {
  it("reads rows from instances or items, with projectPath or project", () => {
    const out = JSON.stringify({
      success: true,
      data: {
        instances: [{ projectPath: "/p/a/", pid: 1, state: "ready" }],
        items: [{ project: "/p/b", port: 7800 }, { port: 1 }],
      },
    });
    expect(parseStatus(out)).toEqual([{ path: "/p/a", pid: 1, state: "ready" }, { path: "/p/b" }]);
  });

  it("rejects output that is not JSON", () => {
    expect(() => parseStatus("Port\tState")).toThrow("did not print JSON");
  });
});
