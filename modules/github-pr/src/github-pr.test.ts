import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentEvent, createAgentsModule } from "@pi-spore/mod-agents/server";
import { kanbanModule } from "@pi-spore/mod-kanban/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type { CardDetail, PrStatus, Workspace } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGithubPrModule, type PrTimer } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("../test-fixtures/fake-gh.mjs", import.meta.url));

let server: TestServer;
let scratch: string;
let agents: ReturnType<typeof createAgentsModule>;
let ghState: string;
/** Polls the module scheduled, run by `tick`. */
let timers: { run: () => Promise<void>; ms: number; cancelled: boolean }[];

const timer: PrTimer = (run, ms) => {
  const entry = { run, ms, cancelled: false };
  timers.push(entry);
  return () => {
    entry.cancelled = true;
  };
};

/** Runs every poll that is due and returns their delays. */
async function tick(): Promise<number[]> {
  const due = timers.filter((entry) => !entry.cancelled);
  timers = [];
  for (const entry of due) await entry.run();
  return due.map((entry) => entry.ms);
}

const scheduledDelays = () => timers.filter((entry) => !entry.cancelled).map((entry) => entry.ms);

async function makeServer(home?: string) {
  agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
    idleStopMs: 60_000,
    startTimeoutMs: 5_000,
  });
  return createTestServer(
    [
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      agents,
      kanbanModule,
      createGithubPrModule({ gh: { command: process.execPath, args: [FAKE_GH, ghState] }, timer }),
    ],
    home ? { home, firstId: 1000 } : {},
  );
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-pr-")));
  ghState = join(scratch, "gh.json");
  writeFileSync(ghState, JSON.stringify({ prs: [] }));
  timers = [];
  server = await makeServer();
});
afterEach(async () => {
  await agents.manager().stopAll();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
}

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface FakeGh {
  prs: Record<string, unknown>[];
  calls: string[][];
  comments?: Record<string, unknown[]>;
  logs?: Record<string, string>;
  createError?: string;
}
const readGh = (): FakeGh => JSON.parse(readFileSync(ghState, "utf8")) as FakeGh;
const editGh = (change: (state: FakeGh) => void) => {
  const state = readGh();
  change(state);
  writeFileSync(ghState, JSON.stringify(state));
};
/** Sets the checks (and optionally a new head) of PR #1 on the fake GitHub. */
const setChecks = (checks: Record<string, unknown>[], head?: string) =>
  editGh((state) => {
    const pr = state.prs[0] as Record<string, unknown>;
    pr.statusCheckRollup = checks;
    if (head) pr.headRefOid = head;
  });

const run = (name: string, conclusion: string, job = "77") => ({
  __typename: "CheckRun",
  name,
  workflowName: "CI",
  status: conclusion === "" ? "IN_PROGRESS" : "COMPLETED",
  conclusion,
  detailsUrl: `https://github.com/owner/repo/actions/runs/5/job/${job}`,
});

/** A Git project with an origin, a card, and a workspace started from the card with a commit on its branch. */
async function setUp(): Promise<{ workspace: Workspace; cardId: string; origin: string }> {
  const repo = join(scratch, "game");
  const origin = join(scratch, "origin.git");
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
  const { card } = await json<{ card: { id: string } }>(
    await server.request("POST", "/api/kanban/cards", {
      title: "Fix the jump",
      body: "The player jumps twice.",
      projectId: project.id,
    }),
    201,
  );
  const { created } = await json<{ created: { workspace: Workspace } }>(
    await server.request("POST", `/api/kanban/cards/${card.id}/start`, { isolation: "new" }),
    201,
  );
  const workspace = created.workspace;
  writeFileSync(join(workspace.path, "a.txt"), "two\n");
  git(workspace.path, "commit", "-q", "-am", "fix jump");
  return { workspace, cardId: card.id, origin };
}

const status = async (workspaceId: string) =>
  json<PrStatus>(await server.request("GET", `/api/github-pr/workspaces/${workspaceId}`));

async function publish(workspace: Workspace) {
  return json<PrStatus>(
    await server.request("POST", `/api/github-pr/workspaces/${workspace.id}/publish`, {
      title: "Fix the jump",
      body: "-- starts like an option",
      base: "main",
      confirm: true,
    }),
    201,
  );
}

async function worker(workspaceId: string): Promise<string> {
  const { agent } = await json<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents", { workspaceId }),
    201,
  );
  return agent.id;
}

const said = (agentId: string) =>
  (server.events.eventsOf(`agent:${agentId}`) as AgentEvent[]).flatMap((event) => {
    const pi =
      event.type === "pi"
        ? (event.event as { type: string; message?: { role: string; content: unknown } })
        : undefined;
    if (pi?.type !== "message_end" || pi.message?.role !== "user") return [];
    const { content } = pi.message;
    return [
      typeof content === "string"
        ? content
        : (content as { text?: string }[]).map((block) => block.text).join(""),
    ];
  });

/** Every gh command must be one pi-spore may run (R9.3). */
function expectOnlyAllowedCalls() {
  for (const call of readGh().calls) {
    const allowed =
      (call[0] === "pr" && (call[1] === "view" || call[1] === "create")) ||
      (call[0] === "run" && call[1] === "view") ||
      (call[0] === "api" && call.includes("--method=GET"));
    expect(allowed, `gh ${call.join(" ")}`).toBe(true);
    for (const forbidden of ["merge", "close", "--auto", "--force", "-f"]) {
      expect(call, `gh ${call.join(" ")}`).not.toContain(forbidden);
    }
  }
}

describe("publish", () => {
  it("offers defaults from the workspace and its card", async () => {
    const { workspace } = await setUp();
    expect(await status(workspace.id)).toMatchObject({
      publishable: true,
      defaults: { title: "Fix the jump", body: "The player jumps twice.", base: "main" },
      watch: { state: "off", tries: 0, maxTries: 3 },
      local: { uncommitted: 0 },
    });
  });

  it("needs an explicit confirm", async () => {
    const { workspace } = await setUp();
    const response = await server.request(
      "POST",
      `/api/github-pr/workspaces/${workspace.id}/publish`,
      { title: "x", body: "", base: "main" },
    );
    expect(response.status).toBe(400);
    expect(readGh().calls ?? []).toEqual([]);
  });

  it("pushes the branch, opens the PR, watches it, and moves the card to Review", async () => {
    const { workspace, cardId, origin } = await setUp();
    const opened = await publish(workspace);

    const line = workspace.line as string;
    expect(git(origin, "rev-parse", line).trim()).toBe(
      git(workspace.path, "rev-parse", "HEAD").trim(),
    );
    expect(readGh().calls[0]).toEqual([
      "pr",
      "create",
      "--base=main",
      `--head=${line}`,
      "--title=Fix the jump",
      "--body=-- starts like an option",
    ]);
    expect(opened).toMatchObject({
      pr: { number: 1, state: "open", line, base: "main", checks: [] },
      watch: { state: "watching", tries: 0 },
    });
    const { card } = await json<CardDetail>(
      await server.request("GET", `/api/kanban/cards/${cardId}`),
    );
    expect(card.column).toBe("review");
    expect(scheduledDelays()).toEqual([30_000]);

    const again = await server.request(
      "POST",
      `/api/github-pr/workspaces/${workspace.id}/publish`,
      {
        title: "x",
        body: "",
        base: "main",
        confirm: true,
      },
    );
    expect(again.status).toBe(409);
    expectOnlyAllowedCalls();
  });

  it("shows gh's error when it cannot open the PR", async () => {
    const { workspace } = await setUp();
    editGh((state) => {
      state.createError = "No commits between main and the branch";
    });
    const response = await server.request(
      "POST",
      `/api/github-pr/workspaces/${workspace.id}/publish`,
      {
        title: "x",
        body: "",
        base: "main",
        confirm: true,
      },
    );
    const body = await json<{ error: { code: string; message: string } }>(response, 422);
    expect(body.error).toMatchObject({ code: "gh_failed" });
    expect(body.error.message).toContain("No commits between");
  });

  it("shows a PR opened outside pi-spore without watching it", async () => {
    const { workspace } = await setUp();
    editGh((state) => {
      state.prs.push({
        number: 9,
        url: "https://github.com/owner/repo/pull/9",
        title: "Made by hand",
        state: "OPEN",
        isDraft: false,
        headRefName: workspace.line,
        baseRefName: "main",
        headRefOid: "abc",
        reviewDecision: "APPROVED",
        mergeable: "CONFLICTING",
        statusCheckRollup: [
          {
            __typename: "StatusContext",
            context: "ci/legacy",
            state: "PENDING",
            targetUrl: "https://ci",
          },
        ],
      });
    });
    const found = await json<PrStatus>(
      await server.request("GET", `/api/github-pr/workspaces/${workspace.id}?refresh=1`),
    );
    expect(found).toMatchObject({
      pr: {
        number: 9,
        review: "approved",
        mergeable: "conflicting",
        checks: [{ name: "ci/legacy", state: "pending", url: "https://ci" }],
      },
      watch: { state: "off" },
    });
    expect(scheduledDelays()).toEqual([]);
  });
});

describe("watch", () => {
  it("backs off while nothing changes, and sends a failed check with its log tail to the worker", async () => {
    const { workspace } = await setUp();
    const agentId = await worker(workspace.id);
    await publish(workspace);

    setChecks([run("test", "")]);
    expect(await tick()).toEqual([30_000]);
    expect(scheduledDelays()).toEqual([30_000]);
    await tick();
    expect(scheduledDelays()).toEqual([60_000]);
    await tick();
    expect(scheduledDelays()).toEqual([120_000]);

    editGh((state) => {
      state.logs = { "77": `${"noise\n".repeat(200)}\x1b[31mexpected 1, got 2\x1b[0m\n` };
    });
    setChecks([run("test", "FAILURE"), run("lint", "SUCCESS", "78")]);
    await tick();
    await until(() => said(agentId).length === 1);
    const [message] = said(agentId);
    expect(message).toContain("Pull request #1 (https://github.com/owner/repo/pull/1) needs work.");
    expect(message).toContain("try 1 of 3");
    expect(message).toContain("- CI / test: https://github.com/owner/repo/actions/runs/5/job/77");
    expect(message).toContain("expected 1, got 2");
    expect(message).not.toContain("\x1b[");
    expect(message).not.toContain("lint");
    expect((message as string).split("noise").length - 1).toBeLessThan(80);
    expect(message).toContain("Do not force-push.");

    const after = await status(workspace.id);
    expect(after.watch).toMatchObject({ state: "watching", tries: 1 });
    expect(after.tries).toMatchObject([
      { summary: "Sent 1 failed check to the worker (try 1 of 3)" },
    ]);

    // The same head again: nothing new to send.
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(said(agentId)).toHaveLength(1);
    expectOnlyAllowedCalls();
  });

  it("stops after 3 tries in a row and waits for the user, who can resume", async () => {
    const { workspace } = await setUp();
    const agentId = await worker(workspace.id);
    await publish(workspace);
    for (const head of ["h1", "h2", "h3"]) {
      setChecks([run("test", "FAILURE", "999")], head);
      await tick();
    }
    await until(() => said(agentId).length === 3);
    expect(said(agentId)[0]).toContain("(The log could not be read: no log for job 999)");

    setChecks([run("test", "FAILURE")], "h4");
    await tick();
    const waiting = await status(workspace.id);
    expect(waiting.watch).toMatchObject({
      state: "waiting",
      tries: 3,
      message: "Stopped after 3 automatic tries in a row. Waiting for you.",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(said(agentId)).toHaveLength(3);

    const resumed = await json<PrStatus>(
      await server.request("POST", `/api/github-pr/workspaces/${workspace.id}/watch`, { on: true }),
    );
    expect(resumed.watch).toMatchObject({ state: "watching", tries: 1 });
    await until(() => said(agentId).length === 4);
  });

  it("starts a new run of tries after a head where every check passed", async () => {
    const { workspace } = await setUp();
    const agentId = await worker(workspace.id);
    await publish(workspace);
    setChecks([run("test", "FAILURE")], "h1");
    await tick();
    setChecks([run("test", "SUCCESS")], "h2");
    await tick();
    expect((await status(workspace.id)).watch).toMatchObject({ state: "watching", tries: 0 });
    setChecks([run("test", "FAILURE")], "h3");
    await tick();
    await until(() => said(agentId).length === 2);
    expect(said(agentId)[1]).toContain("try 1 of 3");
  });

  it("sends new review comments from bots once, and not those of people", async () => {
    const { workspace } = await setUp();
    const agentId = await worker(workspace.id);
    await publish(workspace);
    const bot = { login: "claude[bot]", type: "Bot" };
    editGh((state) => {
      state.comments = {
        comment: [
          { id: 1, user: bot, body: "Overall fine.", html_url: "https://gh/c1" },
          {
            id: 2,
            user: { login: "someone", type: "User" },
            body: "Me too",
            html_url: "https://gh/c2",
          },
        ],
        review: [{ id: 3, user: bot, body: "", html_url: "https://gh/r3", state: "COMMENTED" }],
        review_comment: [
          {
            id: 4,
            user: bot,
            body: "Off by one here.",
            html_url: "https://gh/rc4",
            path: "a.txt",
            line: 1,
          },
        ],
      };
    });
    setChecks([run("review", "SUCCESS")], "h1");
    await tick();
    await until(() => said(agentId).length === 1);
    const [message] = said(agentId);
    expect(message).toContain("New review comments from bots:");
    expect(message).toContain("- claude[bot] (https://gh/c1):\n  > Overall fine.");
    expect(message).toContain(
      "- claude[bot] on `a.txt` line 1 (https://gh/rc4):\n  > Off by one here.",
    );
    expect(message).not.toContain("Me too");
    expect(message).not.toContain("Failed checks");

    await tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(said(agentId)).toHaveLength(1);
  });

  it("waits for the user when the workspace has no worker chat", async () => {
    const { workspace } = await setUp();
    await publish(workspace);
    setChecks([run("test", "FAILURE")], "h1");
    await tick();
    expect((await status(workspace.id)).watch).toMatchObject({
      state: "waiting",
      message: "The workspace has no worker chat to send failures to. Waiting for you.",
    });
  });

  it("ends when the PR is merged, and moves the card to Done", async () => {
    const { workspace, cardId } = await setUp();
    await publish(workspace);
    editGh((state) => {
      (state.prs[0] as Record<string, unknown>).state = "MERGED";
    });
    await tick();
    expect((await status(workspace.id)).watch.state).toBe("done");
    expect(scheduledDelays()).toEqual([]);
    const { card } = await json<CardDetail>(
      await server.request("GET", `/api/kanban/cards/${cardId}`),
    );
    expect(card.column).toBe("done");
  });

  it("turns off and on, and pauses while the workspace is parked", async () => {
    const { workspace } = await setUp();
    await publish(workspace);
    await json(
      await server.request("POST", `/api/github-pr/workspaces/${workspace.id}/watch`, {
        on: false,
      }),
    );
    expect(scheduledDelays()).toEqual([]);
    await json(
      await server.request("POST", `/api/github-pr/workspaces/${workspace.id}/watch`, { on: true }),
    );
    expect(scheduledDelays()).toHaveLength(1);
    await json(await server.request("POST", `/api/workspaces/${workspace.id}/park`));
    expect(scheduledDelays()).toEqual([]);
    await json(await server.request("POST", `/api/workspaces/${workspace.id}/resume`));
    expect(scheduledDelays()).toEqual([30_000]);
  });

  it("picks up after a restart", async () => {
    const home = join(scratch, "home");
    await agents.manager().stopAll();
    server.close();
    server = await makeServer(home);
    const { workspace } = await setUp();
    await publish(workspace);
    await agents.manager().stopAll();
    server.close();
    timers = [];

    server = await makeServer(home);
    expect(scheduledDelays()).toEqual([30_000]);
    await tick();
    expect((await status(workspace.id)).watch.polledAt).toBeDefined();
  });
});
