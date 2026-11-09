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
import { ProjectsKey, projectsModule } from "@pi-spore/mod-projects/server";
import { unityTrait } from "@pi-spore/mod-unity/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import type { ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import {
  CreateWorkspaceResponse,
  Project,
  ProjectConfigView,
  ProjectLines,
  parse,
  Workspace,
  WorkspaceList,
} from "@pi-spore/shared";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reduceWorkspaceList } from "./list.js";
import { type Workspaces, WorkspacesKey, workspacesModule } from "./server.js";

/** Only the Unity trait: the full unity module also needs the actions, artifacts, and attention modules. */
const unityTraitModule: ServerModule = {
  id: "unity",
  requires: ["projects"],
  core: false,
  setup: (host) => host.use(ProjectsKey).registerTrait(unityTrait),
};

const ALL = [projectsModule, vcsGitModule, vcsFolderModule, workspacesModule, unityTraitModule];

let server: TestServer;
let scratch: string;

beforeEach(async () => {
  server = await createTestServer(ALL);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-repos-")));
});
afterEach(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

/** A Git repo shaped like a Unity project: ProjectVersion.txt, a gitignored Library, and generated IDE files. */
function makeUnityRepo(name = "game"): string {
  const repo = join(scratch, name);
  mkdirSync(join(repo, "ProjectSettings"), { recursive: true });
  mkdirSync(join(repo, "Assets"), { recursive: true });
  writeFileSync(
    join(repo, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.10f1\n",
  );
  writeFileSync(join(repo, "Assets", "Player.cs"), "class Player {}\n");
  writeFileSync(join(repo, ".gitignore"), "Library/\nTemp/\n*.csproj\n*.sln\n");
  git(scratch, "init", "-q", "-b", "main", repo);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  mkdirSync(join(repo, "Library", "ScriptAssemblies"), { recursive: true });
  writeFileSync(join(repo, "Library", "ScriptAssemblies", "Game.dll"), "cache");
  writeFileSync(join(repo, "Game.csproj"), "<Project />");
  writeFileSync(join(repo, "game.sln"), "sln");
  return repo;
}

async function json(response: Response, status: number): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.status !== status) {
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function errorCode(response: Response, status: number): Promise<string> {
  const body = (await json(response, status)) as { error: { code: string } };
  return body.error.code;
}

async function addProject(path: string, name?: string): Promise<Project> {
  const body = await json(
    await server.request("POST", "/api/projects", { path, ...(name ? { name } : {}) }),
    201,
  );
  return parse(Type.Object({ project: Project }), body, "add project").project;
}

async function createWorkspace(request: Record<string, unknown>): Promise<CreateWorkspaceResponse> {
  return parse(
    CreateWorkspaceResponse,
    await json(await server.request("POST", "/api/workspaces", request), 201),
    "ws",
  );
}

const WorkspaceBody = Type.Object({ workspace: Workspace });

describe("projects", () => {
  it("registers a Git project by its top level, even from a subfolder, and detects Unity", async () => {
    const repo = makeUnityRepo();
    const project = await addProject(join(repo, "Assets"));

    expect(project).toMatchObject({
      name: "game",
      slug: "game",
      path: repo,
      vcs: "git",
      traits: [{ id: "unity", detail: "6000.3.10f1" }],
    });
  });

  it("registers a plain folder with the folder provider", async () => {
    const folder = join(scratch, "notes");
    mkdirSync(folder);
    expect((await addProject(folder, "My Notes")).vcs).toBe("folder");
  });

  it("gives projects with the same name different slugs", async () => {
    const a = makeUnityRepo("a");
    const b = makeUnityRepo("b");
    expect((await addProject(a, "Game")).slug).toBe("game");
    expect((await addProject(b, "Game")).slug).toBe("game-2");
  });

  it("rejects relative, missing, and duplicate paths, and broken JSON", async () => {
    const repo = makeUnityRepo();
    await addProject(repo);
    expect(
      await errorCode(await server.request("POST", "/api/projects", { path: "game" }), 400),
    ).toBe("relative_path");
    expect(
      await errorCode(
        await server.request("POST", "/api/projects", { path: join(scratch, "nope") }),
        400,
      ),
    ).toBe("not_a_folder");
    expect(
      await errorCode(await server.request("POST", "/api/projects", { path: repo }), 409),
    ).toBe("project_exists");
    const broken = await server.request("POST", "/api/projects", undefined, {
      "content-type": "application/json",
    });
    expect(broken.status).toBe(400);
  });

  it("lists branches and the current one", async () => {
    const repo = makeUnityRepo();
    git(repo, "branch", "feature/x");
    const project = await addProject(repo);
    const lines = parse(
      ProjectLines,
      await json(await server.request("GET", `/api/projects/${project.id}/lines`), 200),
      "lines",
    );
    expect(lines).toEqual({ lines: ["feature/x", "main"], current: "main" });
  });
});

describe("project config", () => {
  const ConfigBody = Type.Object({
    config: ProjectConfigView,
    warnings: Type.Array(Type.String()),
  });
  const config = async (id: string) =>
    parse(
      ConfigBody,
      await json(await server.request("GET", `/api/projects/${id}/config`), 200),
      "config",
    );

  it("uses detected Unity copy defaults and says where each value came from", async () => {
    const project = await addProject(makeUnityRepo());
    expect((await config(project.id)).config).toEqual({
      worktreeCopy: { value: ["Library", "*.csproj", "*.sln"], source: "detected" },
      branchPrefix: { value: "spore", source: "default" },
    });
  });

  it("lets the project file override detection, and the local file override both", async () => {
    const repo = makeUnityRepo();
    mkdirSync(join(repo, ".pi-spore"));
    writeFileSync(
      join(repo, ".pi-spore", "config.toml"),
      '[worktree]\ncopy = ["Library"]\nbranch_prefix = "bk"\n',
    );
    writeFileSync(join(repo, ".pi-spore", "config.local.toml"), '[worktree]\ncopy = [".env"]\n');
    const project = await addProject(repo);
    expect((await config(project.id)).config).toEqual({
      worktreeCopy: { value: [".env"], source: "local override" },
      branchPrefix: { value: "bk", source: "project file" },
    });
  });

  it.each([
    ['[agents.worker]\nmodel = "x"\n', 'sets "agents.worker.model"'],
    ["[worktree\n", "not valid TOML"],
    ["[worktree]\ncopi = []\n", 'unknown key "worktree.copi"'],
  ])("rejects a bad project file: %j", async (text, message) => {
    const repo = makeUnityRepo();
    mkdirSync(join(repo, ".pi-spore"));
    writeFileSync(join(repo, ".pi-spore", "config.toml"), text);
    const project = await addProject(repo);
    const response = await server.request("GET", `/api/projects/${project.id}/config`);
    const body = (await json(response, 422)) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_project_config");
    expect(body.error.message).toContain(message);
  });

  it("warns when Unity has the main copy open", async () => {
    const repo = makeUnityRepo();
    mkdirSync(join(repo, "Temp"));
    writeFileSync(join(repo, "Temp", "UnityLockfile"), "");
    const project = await addProject(repo);
    expect((await config(project.id)).warnings[0]).toContain(
      "Unity may have the main project open",
    );
  });
});

describe("workspaces with Git", () => {
  it("creates a worktree on a new branch and copies the Unity cache and IDE files", async () => {
    const repo = makeUnityRepo();
    const project = await addProject(repo);

    const { workspace, copied, warnings } = await createWorkspace({
      projectId: project.id,
      name: "Fix crafting UI",
      isolation: "new",
    });

    const short = workspace.id.slice(-6).toLowerCase();
    expect(workspace).toMatchObject({
      name: "Fix crafting UI",
      slug: "fix-crafting-ui",
      isolation: "new",
      path: join(server.paths.worktrees, "game", `fix-crafting-ui-${short}`),
      line: `spore/fix-crafting-ui-${short}`,
      base: "main",
      state: "active",
    });
    expect(copied).toEqual(["Game.csproj", "Library", "game.sln"]);
    expect(warnings).toEqual([]);
    expect(
      readFileSync(join(workspace.path, "Library", "ScriptAssemblies", "Game.dll"), "utf8"),
    ).toBe("cache");
    expect(git(workspace.path, "branch", "--show-current").trim()).toBe(workspace.line);
  });

  it("records the base a new branch starts from", async () => {
    const repo = makeUnityRepo();
    git(repo, "branch", "feature/x");
    const project = await addProject(repo);
    const { workspace } = await createWorkspace({
      projectId: project.id,
      name: "From x",
      isolation: "new",
      base: "feature/x",
    });
    expect(workspace.base).toBe("feature/x");
    expect(
      (await json(await server.request("GET", `/api/workspaces/${workspace.id}`), 200)) as object,
    ).toMatchObject({
      workspace: { base: "feature/x" },
    });

    git(repo, "checkout", "-q", "--detach");
    const head = git(repo, "rev-parse", "HEAD").trim();
    const { workspace: detached } = await createWorkspace({
      projectId: project.id,
      name: "Detached",
      isolation: "new",
    });
    expect(detached.base).toBe(head);
  });

  it("records the base given with an existing branch", async () => {
    const repo = makeUnityRepo();
    git(repo, "branch", "run/x");
    const project = await addProject(repo);
    const { workspace } = await createWorkspace({
      projectId: project.id,
      name: "Run",
      isolation: "existing",
      line: "run/x",
      base: "main",
    });
    expect(workspace).toMatchObject({ line: "run/x", base: "main" });
  });

  it("checks out an existing branch, and needs the branch name for it", async () => {
    const repo = makeUnityRepo();
    git(repo, "branch", "feature/x");
    const project = await addProject(repo);

    const missing = await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name: "x",
      isolation: "existing",
    });
    expect(await errorCode(missing, 400)).toBe("line_required");

    const { workspace } = await createWorkspace({
      projectId: project.id,
      name: "Continue x",
      isolation: "existing",
      line: "feature/x",
    });
    expect(git(workspace.path, "branch", "--show-current").trim()).toBe("feature/x");
  });

  it("works in the main checkout without copying anything", async () => {
    const repo = makeUnityRepo();
    const project = await addProject(repo);
    const { workspace, copied } = await createWorkspace({
      projectId: project.id,
      name: "Quick fix",
      isolation: "in-place",
    });
    expect(workspace.path).toBe(repo);
    expect(workspace.line).toBeUndefined();
    expect(copied).toEqual([]);
  });

  it("removes a clean worktree on archive and keeps the branch", async () => {
    const project = await addProject(makeUnityRepo());
    const { workspace } = await createWorkspace({
      projectId: project.id,
      name: "Done",
      isolation: "new",
    });

    const archived = parse(
      WorkspaceBody,
      await json(await server.request("POST", `/api/workspaces/${workspace.id}/archive`), 200),
      "archive",
    ).workspace;

    expect(archived.state).toBe("archived");
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(project.path, "branch", "--list", workspace.line as string).trim()).toContain(
      workspace.line,
    );
  });

  it("refuses to archive a worktree with uncommitted work unless forced", async () => {
    const project = await addProject(makeUnityRepo());
    const { workspace } = await createWorkspace({
      projectId: project.id,
      name: "WIP",
      isolation: "new",
    });
    writeFileSync(join(workspace.path, "Assets", "New.cs"), "class New {}\n");

    const refused = await server.request("POST", `/api/workspaces/${workspace.id}/archive`, {});
    expect(await errorCode(refused, 409)).toBe("uncommitted_work");
    expect(existsSync(join(workspace.path, "Assets", "New.cs"))).toBe(true);

    await json(
      await server.request("POST", `/api/workspaces/${workspace.id}/archive`, { force: true }),
      200,
    );
    expect(existsSync(workspace.path)).toBe(false);
  });

  it("creates one worktree for a repeated request with the same idempotency key", async () => {
    const project = await addProject(makeUnityRepo());
    const request = { projectId: project.id, name: "Once", isolation: "new" };
    const headers = { "idempotency-key": "create-1" };

    const first = await server.request("POST", "/api/workspaces", request, headers);
    const second = await server.request("POST", "/api/workspaces", request, headers);

    const a = parse(CreateWorkspaceResponse, await json(first, 201), "first").workspace;
    const b = parse(CreateWorkspaceResponse, await json(second, 201), "second").workspace;
    expect(b.id).toBe(a.id);
    const list = parse(
      WorkspaceList,
      await json(await server.request("GET", "/api/workspaces"), 200),
      "list",
    );
    expect(list.workspaces).toHaveLength(1);
  });

  it("rejects a copy pattern that leaves the project", async () => {
    const repo = makeUnityRepo();
    mkdirSync(join(repo, ".pi-spore"));
    writeFileSync(join(repo, ".pi-spore", "config.toml"), '[worktree]\ncopy = ["../secrets"]\n');
    const project = await addProject(repo);

    const response = await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name: "Escape",
      isolation: "new",
    });

    expect(await errorCode(response, 422)).toBe("bad_copy_pattern");
    // The half-made worktree was cleaned up.
    expect(git(project.path, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });
});

describe("workspaces with plain folders", () => {
  it("makes a scratch copy and deletes it only when forced", async () => {
    const folder = join(scratch, "notes");
    mkdirSync(folder);
    writeFileSync(join(folder, "todo.md"), "- one\n");
    const project = await addProject(folder);

    const { workspace } = await createWorkspace({
      projectId: project.id,
      name: "Draft",
      isolation: "new",
    });
    expect(readFileSync(join(workspace.path, "todo.md"), "utf8")).toBe("- one\n");
    expect(workspace.line).toBeUndefined();

    const refused = await server.request("POST", `/api/workspaces/${workspace.id}/archive`);
    expect(await errorCode(refused, 409)).toBe("uncommitted_work");
    await json(
      await server.request("POST", `/api/workspaces/${workspace.id}/archive`, { force: true }),
      200,
    );
    expect(existsSync(workspace.path)).toBe(false);
    expect(existsSync(join(folder, "todo.md"))).toBe(true);
  });

  it("does not offer existing-line isolation", async () => {
    const folder = join(scratch, "notes");
    mkdirSync(folder);
    const project = await addProject(folder);
    const response = await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name: "x",
      isolation: "existing",
      line: "main",
    });
    expect(await errorCode(response, 422)).toBe("not_supported");
  });
});

describe("workspace lifecycle", () => {
  it("renames, parks, resumes, and rejects moves from the wrong state", async () => {
    const project = await addProject(makeUnityRepo());
    const { workspace } = await createWorkspace({
      projectId: project.id,
      name: "Old",
      isolation: "in-place",
    });
    const call = async (method: string, path: string, body?: unknown, status = 200) =>
      parse(
        WorkspaceBody,
        await json(
          await server.request(method, `/api/workspaces/${workspace.id}${path}`, body),
          status,
        ),
        path,
      ).workspace;

    expect((await call("PATCH", "", { name: "New" })).name).toBe("New");
    expect((await call("POST", "/park")).state).toBe("parked");
    expect(
      await errorCode(await server.request("POST", `/api/workspaces/${workspace.id}/park`), 409),
    ).toBe("bad_state");
    expect((await call("POST", "/resume")).state).toBe("active");
  });

  it("pushes a list snapshot and an update for every change, and a fresh snapshot on reconnect", async () => {
    const project = await addProject(makeUnityRepo());
    const [empty] = await server.events.snapshot("workspaces:list");
    let list = reduceWorkspaceList([], empty);
    expect(list).toEqual([]);

    const served = async () =>
      parse(WorkspaceList, await json(await server.request("GET", "/api/workspaces"), 200), "list")
        .workspaces;
    /** Runs one change and applies the events it published, which must be exactly one. */
    const change = async (run: () => Promise<unknown>) => {
      const before = server.events.eventsOf("workspaces:list").length;
      await run();
      const events = server.events.eventsOf("workspaces:list").slice(before);
      expect(events).toHaveLength(1);
      list = reduceWorkspaceList(list, events[0]);
      expect(list).toEqual(await served());
    };

    let id = "";
    await change(async () => {
      id = (await createWorkspace({ projectId: project.id, name: "Live", isolation: "in-place" }))
        .workspace.id;
    });
    await change(() => server.request("PATCH", `/api/workspaces/${id}`, { name: "Renamed" }));
    for (const step of ["park", "resume", "archive"]) {
      await change(() => server.request("POST", `/api/workspaces/${id}/${step}`));
    }
    expect(list.map((workspace) => [workspace.name, workspace.state])).toEqual([
      ["Renamed", "archived"],
    ]);

    const [snapshot] = await server.events.snapshot("workspaces:list");
    expect(reduceWorkspaceList([], snapshot)).toEqual(await served());
  });

  it("filters the list by project and state", async () => {
    const a = await addProject(makeUnityRepo("a"));
    const b = await addProject(makeUnityRepo("b"));
    await createWorkspace({ projectId: a.id, name: "a1", isolation: "in-place" });
    const { workspace: b1 } = await createWorkspace({
      projectId: b.id,
      name: "b1",
      isolation: "in-place",
    });
    await server.request("POST", `/api/workspaces/${b1.id}/park`);

    const list = async (query: string) =>
      parse(
        WorkspaceList,
        await json(await server.request("GET", `/api/workspaces${query}`), 200),
        "list",
      ).workspaces.map((workspace) => workspace.name);
    expect(await list(`?projectId=${a.id}`)).toEqual(["a1"]);
    expect(await list("?state=parked")).toEqual(["b1"]);
  });

  it("blocks removing a project with open workspaces", async () => {
    const project = await addProject(makeUnityRepo());
    const { workspace } = await createWorkspace({
      projectId: project.id,
      name: "Open",
      isolation: "in-place",
    });

    expect(
      await errorCode(await server.request("DELETE", `/api/projects/${project.id}`), 409),
    ).toBe("project_in_use");
    await server.request("POST", `/api/workspaces/${workspace.id}/archive`);
    expect((await server.request("DELETE", `/api/projects/${project.id}`)).status).toBe(200);
  });

  it("answers 404 for unknown workspaces and projects", async () => {
    expect(await errorCode(await server.request("GET", "/api/workspaces/nope"), 404)).toBe(
      "workspace_not_found",
    );
    expect(await errorCode(await server.request("GET", "/api/projects/nope"), 404)).toBe(
      "project_not_found",
    );
  });
});

describe("the workspaces interface", () => {
  it("creates workspaces and tells listeners about every state change, even when one throws", async () => {
    const seen: string[] = [];
    let workspaces: Workspaces | undefined;
    const listener: ServerModule = {
      id: "listener",
      requires: ["workspaces"],
      core: false,
      setup(host) {
        workspaces = host.use(WorkspacesKey);
        workspaces.afterStateChange(() => {
          throw new Error("broken listener");
        });
        workspaces.afterStateChange((workspace, previous) => {
          seen.push(`${workspace.name}: ${previous} -> ${workspace.state}`);
        });
      },
    };
    server.close();
    server = await createTestServer([...ALL, listener]);
    const project = await addProject(makeUnityRepo());
    const { workspace } = await (workspaces as Workspaces).create({
      projectId: project.id,
      name: "Made",
      isolation: "in-place",
    });

    for (const step of ["park", "resume", "archive"]) {
      await json(await server.request("POST", `/api/workspaces/${workspace.id}/${step}`), 200);
    }
    expect(seen).toEqual([
      "Made: active -> parked",
      "Made: parked -> active",
      "Made: active -> archived",
    ]);
  });
});
