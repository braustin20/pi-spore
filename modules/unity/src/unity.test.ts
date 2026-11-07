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
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import {
  CreateWorkspaceResponse,
  OpenUnityResponse,
  parse,
  UnityWorkspaceView,
  type Workspace,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProcessInfo, parseStatus } from "./editors.js";
import { createUnityModule } from "./server.js";

const FAKE_UNITY = fileURLToPath(new URL("../test-fixtures/fake-unity.mjs", import.meta.url));

let server: TestServer;
let scratch: string;
let stateFile: string;
/** What the fake process list shows; tests add Unity processes here. */
let processes: ProcessInfo[] | undefined;

interface FakeState {
  instances: { projectPath: string; pid: number; state: string }[];
  calls: string[][];
  openFails?: boolean;
  closeFails?: boolean;
}
const readState = (): FakeState => JSON.parse(readFileSync(stateFile, "utf8"));
const writeState = (change: Partial<FakeState>) =>
  writeFileSync(stateFile, JSON.stringify({ ...readState(), ...change }));
/** The subcommands the fake CLI was called with, without `status`. */
const actions = () =>
  readState()
    .calls.filter((call) => call[0] !== "status")
    .map((call) => call.filter((arg) => !arg.startsWith("--")).join(" "));

async function start(unityCommand = process.execPath) {
  server = await createTestServer([
    projectsModule,
    vcsGitModule,
    workspacesModule,
    createUnityModule({
      unity: { command: unityCommand, args: [FAKE_UNITY, stateFile] },
      processes: async () => processes,
    }),
  ]);
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-unity-")));
  stateFile = join(scratch, "unity-state.json");
  writeFileSync(stateFile, JSON.stringify({ instances: [], calls: [] }));
  processes = [];
  await start();
});
afterEach(() => {
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
