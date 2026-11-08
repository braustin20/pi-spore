import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { type AgentEvent, createAgentsModule } from "@pi-spore/mod-agents/server";
import { artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule } from "@pi-spore/mod-attention/server";
import { kanbanModule } from "@pi-spore/mod-kanban/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { runsModule } from "@pi-spore/mod-runs/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { JobTimer, ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type { CardDetail, PrStatus, Workspace } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGithubPrModule, type PullRequests, PullRequestsKey } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));
const FAKE_GH = fileURLToPath(new URL("../test-fixtures/fake-gh.mjs", import.meta.url));

let server: TestServer;
let scratch: string;
let agents: ReturnType<typeof createAgentsModule>;
let ghState: string;
let pullRequests: PullRequests;
/** Polls the runner scheduled, run by `tick`. */
let timers: { run: () => Promise<void>; ms: number; cancelled: boolean }[];

const timer: JobTimer = (run, ms) => {
  const entry = { run, ms, cancelled: false };
  timers.push(entry);
  return () => {
    entry.cancelled = true;
  };
};

// The test clock ticks once per call, so a delay is a few ms short of the one the module asked for.
const wholeSeconds = (ms: number) => Math.round(ms / 1000) * 1000;

/** The discover job's interval; no other timer in these tests has this delay, so the helpers can tell it apart. */
const DISCOVER_MS = 17 * 60_000;
const isDiscover = (entry: { ms: number }) => wholeSeconds(entry.ms) === DISCOVER_MS;

/** Runs every timer that is due (the discover look too), waits for each to commit, and returns the poll delays. */
async function tick(): Promise<number[]> {
  const due = timers.filter((entry) => !entry.cancelled);
  timers = [];
  for (const entry of due) await entry.run();
  return due.filter((entry) => !isDiscover(entry)).map((entry) => wholeSeconds(entry.ms));
}

const scheduledDelays = () =>
  timers
    .filter((entry) => !entry.cancelled && !isDiscover(entry))
    .map((entry) => wholeSeconds(entry.ms));

/** Keeps the interface the runs module will call. */
const probe: ServerModule = {
  id: "github-pr-probe",
  requires: ["github-pr"],
  core: false,
  setup(host) {
    pullRequests = host.use(PullRequestsKey);
  },
};

async function makeServer(home?: string, startAt?: number, firstId = 1000) {
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
      attentionModule,
      actionsModule,
      artifactsModule,
      pipelinesModule,
      runsModule,
      kanbanModule,
      createGithubPrModule({
        gh: { command: process.execPath, args: [FAKE_GH, ghState] },
        discoverIntervalMs: DISCOVER_MS,
      }),
      probe,
    ],
    { timer, ...(home ? { home, firstId } : {}), ...(startAt ? { startAt } : {}) },
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
  // A card's brief may still be on its way to the fake agent; stopping it then would fail the delivery late.
  await until(
    () =>
      server.store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM agents_deliveries WHERE state = 'pending'",
      )?.n === 0,
  );
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
  viewError?: string;
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

/**
 * A Git project with an origin, a card, and a workspace started from the card with a commit on its branch. Starting
 * from a card makes the worker chat and sends it the card's brief. Without `card`, the workspace has no chat.
 */
async function setUp(
  card = true,
): Promise<{ workspace: Workspace; cardId: string; origin: string }> {
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
  let cardId = "";
  let workspace: Workspace;
  if (card) {
    const made = await json<{ card: { id: string } }>(
      await server.request("POST", "/api/kanban/cards", {
        title: "Fix the jump",
        body: "The player jumps twice.",
        projectId: project.id,
      }),
      201,
    );
    cardId = made.card.id;
    const { created } = await json<{ created: { workspace: Workspace } }>(
      await server.request("POST", `/api/kanban/cards/${cardId}/start`, { isolation: "new" }),
      201,
    );
    workspace = created.workspace;
  } else {
    ({ workspace } = await json<{ workspace: Workspace }>(
      await server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "Fix the jump",
        isolation: "new",
      }),
      201,
    ));
  }
  writeFileSync(join(workspace.path, "a.txt"), "two\n");
  git(workspace.path, "commit", "-q", "-am", "fix jump");
  if (card) {
    // The brief's run ends and the module looks for a PR once. Wait for that look, so it cannot reach into a test.
    await until(() => {
      try {
        return (readGh().calls ?? []).length > 0;
      } catch {
        return false; // The fake gh is writing its state file.
      }
    });
    editGh((state) => {
      state.calls = [];
    });
  }
  return { workspace, cardId, origin };
}

const status = async (workspaceId: string) =>
  json<PrStatus>(await server.request("GET", `/api/github-pr/workspaces/${workspaceId}`));

async function publish(workspace: Workspace) {
  const opened = await json<PrStatus>(
    await server.request("POST", `/api/github-pr/workspaces/${workspace.id}/publish`, {
      title: "Fix the jump",
      body: "-- starts like an option",
      base: "main",
      confirm: true,
    }),
    201,
  );
  // The runner sets the first poll's timer on its next tick.
  await until(() => scheduledDelays().length === 1);
  return opened;
}

/** The workspace's worker chat; starting from a card made it already. */
async function worker(workspaceId: string): Promise<string> {
  const response = await server.request("POST", "/api/agents", { workspaceId });
  const { agent } = await json<{ agent: { id: string } }>(
    response,
    response.status === 201 ? 201 : 200,
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
    const text =
      typeof content === "string"
        ? content
        : (content as { text?: string }[]).map((block) => block.text).join("");
    // Only the PR watch's messages; the card's brief comes first.
    return text.startsWith("Pull request #") ? [text] : [];
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

  it("opens a PR for another module through the interface", async () => {
    const { workspace } = await setUp();
    const pr = await pullRequests.open(workspace.id, {
      title: "Ship the jump",
      body: "Fixed.",
      base: "main",
    });
    expect(pr).toMatchObject({
      number: 1,
      title: "Ship the jump",
      state: "open",
      line: workspace.line,
      base: "main",
    });
    expect(readGh().calls.filter((call) => call[0] === "pr" && call[1] === "create")).toHaveLength(
      1,
    );
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
          { __typename: "StatusContext", context: "ci/bare", state: "SUCCESS", targetUrl: null },
          {
            __typename: "CheckRun",
            name: "app",
            workflowName: "",
            status: "COMPLETED",
            conclusion: "NEUTRAL",
            detailsUrl: "",
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
        checks: [
          { name: "ci/legacy", state: "pending", url: "https://ci" },
          { name: "ci/bare", state: "pass" },
          { name: "app", state: "neutral" },
        ],
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
    expect(resumed.watch).toMatchObject({ state: "watching", tries: 0 });
    await until(() => said(agentId).length === 4);
    expect((await status(workspace.id)).watch).toMatchObject({ state: "watching", tries: 1 });
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
    const { workspace } = await setUp(false);
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
    // The job polls now, then sets the timer for the next poll.
    await until(() => scheduledDelays().length === 1);
    await json(await server.request("POST", `/api/workspaces/${workspace.id}/park`));
    expect(scheduledDelays()).toEqual([]);
    await json(await server.request("POST", `/api/workspaces/${workspace.id}/resume`));
    await until(() => scheduledDelays().length === 1);
    expect(scheduledDelays()).toEqual([30_000]);
  });

  /** Publishes on a server at `home`, then restarts it `later` ms on, with the timers cleared. */
  async function publishThenRestart(later: number, beforeRestart?: () => void) {
    const home = join(scratch, "home");
    await agents.manager().stopAll();
    server.close();
    server = await makeServer(home);
    const { workspace } = await setUp();
    await publish(workspace);
    beforeRestart?.();
    await agents.manager().stopAll();
    server.close();
    timers = [];
    // The restart must not hand out the first server's job ids again, as the discover job starts at once.
    server = await makeServer(home, 1_700_000_000_000 + later, 5000);
    return workspace;
  }

  it("picks up after a restart with the time that was left", async () => {
    const workspace = await publishThenRestart(10_000);
    await until(() => scheduledDelays().length === 1);
    // The first server's discover timer is cancelled at start; the new one has the discover delay.
    const [delay] = timers
      .filter((entry) => !entry.cancelled && !isDiscover(entry))
      .map((entry) => entry.ms);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThan(25_000);
    await tick();
    expect((await status(workspace.id)).watch.polledAt).toBeDefined();
  });

  it("starts a watch job for a watch from before the runner", async () => {
    const workspace = await publishThenRestart(10_000, () =>
      server.store.run("DELETE FROM core_jobs WHERE kind = 'github-pr.watch'"),
    );
    await until(() => scheduledDelays().length === 1);
    await tick();
    expect((await status(workspace.id)).watch.polledAt).toBeDefined();
  });
});

describe("refresh", () => {
  it("stores the view but never sends feedback; the watch job sends once", async () => {
    const { workspace } = await setUp();
    const agentId = await worker(workspace.id);
    await publish(workspace);
    setChecks([run("test", "FAILURE")], "h1");

    const refreshed = await json<PrStatus>(
      await server.request("GET", `/api/github-pr/workspaces/${workspace.id}?refresh=1`),
    );
    expect(refreshed.pr?.headId).toBe("h1");
    const sends = () =>
      server.store.all("SELECT 1 FROM agents_deliveries WHERE message LIKE 'Pull request #%'")
        .length;
    expect(sends()).toBe(0);
    expect(refreshed.tries).toEqual([]);

    await tick();
    await until(() => said(agentId).length === 1);
    expect(sends()).toBe(1);
    expect((await status(workspace.id)).tries).toHaveLength(1);
  });
});

describe("finding a PR by itself", () => {
  /** A PR on the workspace's branch, as `gh pr create` in a terminal would make it. */
  const openOutside = (workspace: Workspace, fields: Record<string, unknown> = {}) =>
    editGh((state) => {
      const number = state.prs.length + 1;
      state.prs.push({
        number,
        url: `https://github.com/owner/repo/pull/${number}`,
        title: "Made by hand",
        state: "OPEN",
        isDraft: false,
        headRefName: workspace.line,
        baseRefName: "main",
        headRefOid: "abc",
        reviewDecision: "",
        mergeable: "UNKNOWN",
        statusCheckRollup: [],
        ...fields,
      });
    });

  /** Runs the discover look that is due. */
  async function lookNow() {
    await until(() => timers.some((entry) => !entry.cancelled && isDiscover(entry)));
    await tick();
  }

  const detail = async (cardId: string) =>
    json<CardDetail>(await server.request("GET", `/api/kanban/cards/${cardId}`));
  const viewCalls = () => readGh().calls.filter((call) => call[0] === "pr" && call[1] === "view");

  it("moves the card to Review when a PR is opened outside pi-spore", async () => {
    const { workspace, cardId } = await setUp();
    await lookNow();
    expect((await detail(cardId)).card.column).not.toBe("review");

    openOutside(workspace);
    await lookNow();
    const { card, history } = await detail(cardId);
    expect(card.column).toBe("review");
    expect(history.at(-1)?.reason).toBe("PR #1 opened");
    expectOnlyAllowedCalls();
  });

  it("does not watch the PR it found", async () => {
    const { workspace } = await setUp();
    openOutside(workspace);
    await lookNow();
    expect((await status(workspace.id)).watch.state).toBe("off");
    expect(server.store.all("SELECT 1 FROM core_jobs WHERE kind = 'github-pr.watch'")).toEqual([]);
    expect(scheduledDelays()).toEqual([]);
  });

  it("moves the card to Done, with Review in its history, for a PR found merged", async () => {
    const { workspace, cardId } = await setUp();
    openOutside(workspace, { state: "MERGED" });
    await lookNow();
    const { card, history } = await detail(cardId);
    expect(card.column).toBe("done");
    expect(history.slice(-2).map((move) => move.reason)).toEqual(["PR #1 opened", "PR #1 merged"]);
  });

  it("does not move the card when the branch has no PR or only a closed one", async () => {
    const { workspace, cardId } = await setUp();
    await lookNow();
    const before = (await detail(cardId)).card.column;
    openOutside(workspace, { state: "CLOSED" });
    await lookNow();
    expect((await detail(cardId)).card.column).toBe(before);
  });

  it("follows a found PR to merged on a later look", async () => {
    const { workspace, cardId } = await setUp();
    openOutside(workspace);
    await lookNow();
    expect((await detail(cardId)).card.column).toBe("review");
    editGh((state) => {
      (state.prs[0] as Record<string, unknown>).state = "MERGED";
    });
    await lookNow();
    expect((await detail(cardId)).card.column).toBe("done");
    expect((await status(workspace.id)).pr?.state).toBe("merged");
  });

  it("does not look at a parked workspace", async () => {
    const { workspace } = await setUp();
    openOutside(workspace);
    await json(await server.request("POST", `/api/workspaces/${workspace.id}/park`));
    await lookNow();
    expect(viewCalls()).toEqual([]);
  });

  it("looks as soon as a chat run ends, without a timer", async () => {
    const { workspace, cardId } = await setUp();
    const agentId = await worker(workspace.id);
    openOutside(workspace);
    await json(
      await server.request("POST", `/api/agents/${agentId}/prompt`, { message: "carry on" }),
    );
    await until(async () => (await detail(cardId)).card.column === "review");
  });

  it("keeps going when gh fails for a workspace", async () => {
    const { workspace, cardId } = await setUp();
    editGh((state) => {
      state.viewError = "none of the git remotes point to a known GitHub host";
    });
    await lookNow();
    await lookNow();
    expect(viewCalls()).toHaveLength(2);
    expect((await detail(cardId)).card.column).not.toBe("review");

    editGh((state) => {
      delete state.viewError;
    });
    openOutside(workspace);
    await lookNow();
    expect((await detail(cardId)).card.column).toBe("review");
  });
});
