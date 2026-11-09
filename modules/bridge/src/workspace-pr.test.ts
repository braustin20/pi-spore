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
import { createGithubPrModule } from "@pi-spore/mod-github-pr/server";
import { kanbanModule } from "@pi-spore/mod-kanban/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { runsModule } from "@pi-spore/mod-runs/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type { Approval, Workspace, WorkspacePrSubject } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeModule } from "./server.js";
import { json } from "./testing.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));
const FAKE_GH = fileURLToPath(
  new URL("../../github-pr/test-fixtures/fake-gh.mjs", import.meta.url),
);

let scratch: string;
let servers: { server: TestServer; agents: ReturnType<typeof createAgentsModule> }[];

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-workspace-pr-")));
  servers = [];
});
afterEach(async () => {
  for (const { server, agents } of servers) {
    // The PR watch job of an approved PR must not fire after the store closes.
    server.services.jobs.stop();
    await agents.manager().stopAll();
    server.close();
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

const ghState = () => join(scratch, "gh.json");

async function start(options: { withoutGithubPr?: boolean } = {}) {
  if (!existsSync(ghState())) writeFileSync(ghState(), JSON.stringify({ prs: [] }));
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
    idleStopMs: 60_000,
    startTimeoutMs: 1_000,
  });
  const server = await createTestServer(
    [
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      agents,
      actionsModule,
      attentionModule,
      kanbanModule,
      artifactsModule,
      ...(options.withoutGithubPr
        ? []
        : [
            createGithubPrModule({
              gh: { command: process.execPath, args: [FAKE_GH, ghState()] },
            }),
          ]),
      pipelinesModule,
      runsModule,
      bridgeModule,
    ],
    { listen: true },
  );
  servers.push({ server, agents });
  return server;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const ghCalls = () =>
  (JSON.parse(readFileSync(ghState(), "utf8")) as { calls?: string[][] }).calls ?? [];
const prCreates = () => ghCalls().filter((call) => call[0] === "pr" && call[1] === "create");
const remoteHas = (origin: string, line: string) => git(origin, "branch", "--list", line) !== "";
const decide = (server: TestServer, id: string, action: "approve" | "decline", body: object) =>
  server.request("POST", `/api/attention/approvals/${id}/${action}`, body);
const openApprovals = async (server: TestServer) =>
  (
    await json<{ approvals: Approval[] }>(
      await server.request("GET", "/api/attention/approvals?state=open"),
    )
  ).approvals;

/** Calls a bridge route as the agent would; `receipt` is the tool call id the idempotency middleware keys on. */
function asAgent(server: TestServer, agentId: string, workspaceId: string, readOnly = false) {
  const token = server.agentTokens.issue({
    agentId,
    workspaceId,
    ...(readOnly ? { readOnly } : {}),
  });
  return (method: string, path: string, body?: unknown, receipt?: string) =>
    server.request(method, `/api/bridge/${path}`, body, {
      "x-pi-spore-token": "",
      authorization: `Bearer ${token}`,
      ...(receipt ? { "idempotency-key": receipt } : {}),
    });
}

/** A worker chat in the workspace, and the bridge caller it uses. */
async function chatOf(server: TestServer, workspaceId: string) {
  const { agent } = await json<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents", { workspaceId }),
    201,
  );
  return asAgent(server, agent.id, workspaceId);
}

/** A Git project with a bare `origin`, and a workspace on its own branch with one commit. */
async function branchWorkspace(server: TestServer, name: string) {
  const repo = join(scratch, name);
  const origin = join(scratch, `${name}-origin.git`);
  git(scratch, "init", "-q", "--bare", origin);
  git(scratch, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: repo }),
    201,
  );
  const { workspace } = await json<{ workspace: Workspace }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name,
      isolation: "new",
    }),
    201,
  );
  writeFileSync(join(workspace.path, "a.txt"), "two\n");
  git(workspace.path, "commit", "-q", "-am", "change");
  const call = await chatOf(server, workspace.id);
  return { workspace, origin, call, line: workspace.line as string };
}

const ask = (call: Awaited<ReturnType<typeof chatOf>>, title = "Ship it", receipt?: string) =>
  call("POST", "workspace/pr", { title, body: "What changed." }, receipt);

describe("a chat asks to open its workspace's PR", () => {
  it("files one workspace-pr approval, pushes and creates nothing, and answers a retry with the same approval", async () => {
    const server = await start();
    const { call, origin, line, workspace } = await branchWorkspace(server, "ask");

    const first = await json<{ approval: Approval }>(await ask(call, "Ship it", "tool-1"), 201);
    const retry = await json<{ approval: Approval }>(await ask(call, "Ship it", "tool-1"), 201);

    expect(retry.approval.id).toBe(first.approval.id);
    expect(first.approval).toMatchObject({
      kind: "workspace-pr",
      state: "open",
      subject: { workspaceId: workspace.id, title: "Ship it", body: "What changed.", base: "main" },
    });
    expect((await openApprovals(server)).map((approval) => approval.id)).toEqual([
      first.approval.id,
    ]);
    expect(prCreates()).toEqual([]);
    expect(remoteHas(origin, line)).toBe(false);
  });

  it("opens the PR once with the edited title on approve, and pushes the branch", async () => {
    const server = await start();
    const { call, origin, line } = await branchWorkspace(server, "approve");
    const { approval } = await json<{ approval: Approval }>(await ask(call), 201);

    await json(
      await decide(server, approval.id, "approve", {
        subject: { ...(approval.subject as WorkspacePrSubject), title: "Edited title" },
      }),
    );

    expect(prCreates()).toHaveLength(1);
    expect(prCreates()[0]).toEqual(
      expect.arrayContaining(["--title=Edited title", "--body=What changed.", "--base=main"]),
    );
    expect(remoteHas(origin, line)).toBe(true);
    expect(await openApprovals(server)).toEqual([]);
  });

  it("opens nothing on decline, and allows a new request", async () => {
    const server = await start();
    const { call, origin, line } = await branchWorkspace(server, "decline");
    const { approval } = await json<{ approval: Approval }>(await ask(call), 201);

    await json(await decide(server, approval.id, "decline", { note: "Reword it" }));

    expect(prCreates()).toEqual([]);
    expect(remoteHas(origin, line)).toBe(false);
    const again = await json<{ approval: Approval }>(await ask(call, "Better"), 201);
    expect(again.approval.id).not.toBe(approval.id);
  });

  it("answers 422 not_supported for a workspace that cannot be published, and files nothing", async () => {
    const server = await start();
    const folder = join(scratch, "plain");
    mkdirSync(join(folder, ".pi-spore"), { recursive: true });
    writeFileSync(join(folder, ".pi-spore", "config.toml"), "");
    const { project } = await json<{ project: { id: string } }>(
      await server.request("POST", "/api/projects", { path: folder }),
      201,
    );
    const { workspace } = await json<{ workspace: Workspace }>(
      await server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "plain",
        isolation: "in-place",
      }),
      201,
    );
    const call = await chatOf(server, workspace.id);

    const response = await ask(call);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "not_supported" } });
    expect(await openApprovals(server)).toEqual([]);
  });

  it("answers 409 workspace_pr_asked, naming the first approval, while one is open", async () => {
    const server = await start();
    const { call } = await branchWorkspace(server, "twice");
    const { approval } = await json<{ approval: Approval }>(await ask(call), 201);

    const response = await ask(call, "Again");

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("workspace_pr_asked");
    expect(body.error.message).toContain(approval.id);
    expect((await openApprovals(server)).map((entry) => entry.id)).toEqual([approval.id]);
  });

  it("answers 409 pr_exists when the workspace's PR is open, and files nothing", async () => {
    const server = await start();
    const { call, workspace } = await branchWorkspace(server, "exists");
    await json(
      await server.request("POST", `/api/github-pr/workspaces/${workspace.id}/publish`, {
        title: "Already",
        body: "",
        base: "main",
        confirm: true,
      }),
      201,
    );

    const response = await ask(call);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "pr_exists" } });
    expect(await openApprovals(server)).toEqual([]);
  });

  it("answers 422 not_supported without the github-pr module", async () => {
    const server = await start({ withoutGithubPr: true });
    const { call } = await branchWorkspace(server, "nomod");

    const response = await ask(call);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "not_supported" } });
    expect(await openApprovals(server)).toEqual([]);
  });

  it.each([
    ["workspaceId", "other"],
    ["base", "develop"],
  ])(
    "keeps the approval open when approve changes %s, with 422 approval_workspace_changed",
    async (field, value) => {
      const server = await start();
      const { call, origin, line } = await branchWorkspace(
        server,
        `changed-${field.toLowerCase()}`,
      );
      const { approval } = await json<{ approval: Approval }>(await ask(call), 201);

      const response = await decide(server, approval.id, "approve", {
        subject: { ...(approval.subject as WorkspacePrSubject), [field]: value },
      });

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: "approval_workspace_changed" },
      });
      expect((await openApprovals(server)).map((entry) => entry.id)).toEqual([approval.id]);
      expect(prCreates()).toEqual([]);
      expect(remoteHas(origin, line)).toBe(false);
    },
  );
});

describe("a chat pushes its workspace's branch", () => {
  const push = (call: Awaited<ReturnType<typeof chatOf>>) => call("POST", "workspace/push", {});

  it("sends the workspace's commit to origin and answers the remote and line", async () => {
    const server = await start();
    const { call, origin, line, workspace } = await branchWorkspace(server, "push");
    expect(remoteHas(origin, line)).toBe(false);

    const answer = await json<{ remote: string; line: string }>(await push(call));

    expect(answer).toEqual({ remote: "origin", line });
    expect(git(origin, "rev-parse", line)).toBe(git(workspace.path, "rev-parse", "HEAD"));
  });

  it("refuses a side chat with 403 read_only_chat, and pushes nothing", async () => {
    const server = await start();
    const { origin, line, workspace } = await branchWorkspace(server, "push-side");
    // The workspace's chat already exists, so this answers 200 with it.
    const { agent } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      200,
    );
    const side = asAgent(server, agent.id, workspace.id, true);

    const response = await push(side);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "read_only_chat" } });
    expect(remoteHas(origin, line)).toBe(false);
  });

  it("answers 422 not_supported for a workspace without its own branch", async () => {
    const server = await start();
    const folder = join(scratch, "push-plain");
    mkdirSync(join(folder, ".pi-spore"), { recursive: true });
    writeFileSync(join(folder, ".pi-spore", "config.toml"), "");
    const { project } = await json<{ project: { id: string } }>(
      await server.request("POST", "/api/projects", { path: folder }),
      201,
    );
    const { workspace } = await json<{ workspace: Workspace }>(
      await server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "plain",
        isolation: "in-place",
      }),
      201,
    );
    const call = await chatOf(server, workspace.id);

    const response = await push(call);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "not_supported" } });
  });

  it("answers 409 push_failed when origin has a commit the branch lacks, and leaves origin alone", async () => {
    const server = await start();
    const { call, origin, line, workspace } = await branchWorkspace(server, "push-reject");
    await json(await push(call));
    const pushed = git(origin, "rev-parse", line);
    // Origin gets a commit from another clone, so the workspace's next push would rewind it.
    const other = join(scratch, "push-reject-other");
    git(scratch, "clone", "-q", "-b", line, origin, other);
    writeFileSync(join(other, "b.txt"), "theirs\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "theirs");
    git(other, "push", "-q", "origin", line);
    const theirs = git(origin, "rev-parse", line);
    writeFileSync(join(workspace.path, "a.txt"), "three\n");
    git(workspace.path, "commit", "-q", "-am", "mine");

    const response = await push(call);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "push_failed" } });
    expect(theirs).not.toBe(pushed);
    expect(git(origin, "rev-parse", line)).toBe(theirs);
  });
});
