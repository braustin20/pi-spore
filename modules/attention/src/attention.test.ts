import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Agents, AgentsKey, createAgentsModule } from "@pi-spore/mod-agents/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type {
  Approval,
  ChatKind,
  HomeNotice,
  Inbox,
  InboxEvent,
  InboxWorkspace,
  RunningItem,
} from "@pi-spore/shared";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Approvals,
  ApprovalsKey,
  attentionModule,
  buildWorkspaceRows,
  type HomeItems,
  HomeItemsKey,
  INBOX_TOPIC,
} from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let server: TestServer;
let scratch: string;
let agents: ReturnType<typeof createAgentsModule>;
let approvals: Approvals;
let homeItems: HomeItems;
/** What the test Home source reports now. */
let notices: HomeNotice[];
/** Makes a second test source throw. */
let broken: boolean;
/** The test source answers its next reads from here before it answers from `notices`, so a test can hold a read. */
let heldReads: Promise<HomeNotice[]>[];
let sourceReads: number;
let agentsApi: Agents;
/** What the test gate was asked to carry out; `fail` makes it throw. `decided` lists its decided() calls. */
let gate: {
  approved: unknown[];
  decided: { subject: unknown; state: string; approved: boolean }[];
  fail: boolean;
  failDecided: boolean;
  release?: () => void;
  hold?: Promise<void>;
};

/** Another module with its own gate, as a model upgrade or "close Unity?" would register one (ADR 0100). */
const gateModule: ServerModule = {
  id: "gate",
  requires: ["agents", "attention"],
  core: false,
  setup(host) {
    agentsApi = host.use(AgentsKey);
    approvals = host.use(ApprovalsKey);
    approvals.register({
      kind: "test-gate",
      subject: Type.Object({ model: Type.String() }, { additionalProperties: false }),
      approve: async (subject) => {
        await gate.hold;
        if (gate.fail) throw new ApiError(409, "gate_failed", "The gate could not go on");
        gate.approved.push(subject);
        return `Switched to ${subject.model}.`;
      },
      decided: (subject, approval, approved) => {
        if (gate.failDecided) throw new ApiError(409, "decided_failed", "The run is gone");
        gate.decided.push({ subject, state: approval.state, approved });
      },
    });
  },
};

/** Another module that adds items to Home, as github-pr, kanban, and usage do (ADR 0155). */
const sourceModule: ServerModule = {
  id: "source",
  requires: ["attention"],
  core: false,
  setup(host) {
    homeItems = host.use(HomeItemsKey);
    homeItems.register("test-source", () => {
      sourceReads++;
      return heldReads.shift() ?? notices;
    });
    homeItems.register("broken-source", () => {
      if (broken) throw new Error("source failed");
      return [];
    });
  },
};

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-attention-")));
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
    vcsFolderModule,
    workspacesModule,
    agents,
    attentionModule,
    gateModule,
    sourceModule,
  ]);
  notices = [];
  broken = false;
  heldReads = [];
  sourceReads = 0;
  gate = { approved: [], decided: [], fail: false, failDecided: false };
});
afterEach(async () => {
  await agents.manager().stopAll();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function makeAgent(name: string) {
  const folder = join(scratch, name);
  mkdirSync(folder);
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await json<{ workspace: { id: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name,
      isolation: "in-place",
    }),
    201,
  );
  const { agent } = await json<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
    201,
  );
  return { agentId: agent.id, workspaceId: workspace.id };
}

const inbox = async () => json<Inbox>(await server.request("GET", "/api/attention/inbox"));
const kinds = async () =>
  (await inbox()).items.map(
    (item) => `${item.kind} ${item.kind === "notice" ? item.title : item.workspace.name}`,
  );
const prompt = (agentId: string, message: string) =>
  server.request("POST", `/api/agents/${agentId}/prompt`, { message });

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const workspace: InboxWorkspace = {
  id: "ws-1",
  name: "home",
  projectName: "pi-spore",
  state: "active",
};

describe("Home inbox", () => {
  it("is empty with nothing to do", async () => {
    await makeAgent("quiet");
    expect(await inbox()).toEqual({ items: [], interrupted: [], running: [] });
  });

  it("shows an open extension dialog until it is answered", async () => {
    const { agentId } = await makeAgent("dialogs");
    await json(await prompt(agentId, "/dialog"));
    await until(async () => (await kinds()).includes("dialog dialogs"));
    expect((await inbox()).items[0]).toMatchObject({
      kind: "dialog",
      agentId,
      dialog: { id: "dlg-1", method: "confirm", title: "Proceed?" },
    });
    expect((await inbox()).running).toMatchObject([{ agentId, status: "busy" }]);

    await json(
      await server.request("POST", `/api/agents/${agentId}/dialog`, {
        dialogId: "dlg-1",
        confirmed: true,
      }),
    );
    await until(async () => !(await kinds()).includes("dialog dialogs"));
  });

  it("shows a failed agent with its error", async () => {
    const { agentId } = await makeAgent("broken");
    await prompt(agentId, "crash");
    await until(async () => (await kinds()).includes("failed broken"));
    const item = (await inbox()).items[0] as { error: string };
    expect(item.error).toContain("boom: the fake agent crashed");
  });

  it("does not show a pipeline stage agent as finished: the pipeline reads its report", async () => {
    const { workspaceId } = await makeAgent("lane");
    const stage = server.store.transaction(() => {
      const agent = agentsApi.createStage(workspaceId, { role: "reviewer", title: "Review 1" });
      agentsApi.deliver(agent.id, "one");
      return agent;
    });
    await until(async () => agentsApi.get(stage.id).status === "idle");
    expect(await kinds()).toEqual([]);
  });

  it("shows a finished agent newest first, and drops it when seen or messaged", async () => {
    const first = await makeAgent("first");
    const second = await makeAgent("second");
    await json(await prompt(first.agentId, "one"));
    await until(async () => (await kinds()).includes("finished first"));
    await json(await prompt(second.agentId, "two"));
    await until(async () => (await kinds()).length === 2);
    expect(await kinds()).toEqual(["finished second", "finished first"]);

    await json(await server.request("POST", `/api/agents/${second.agentId}/seen`));
    expect(await kinds()).toEqual(["finished first"]);
    await json(await prompt(second.agentId, "three"));
    await until(async () => (await kinds()).includes("finished second"));
    await json(await server.request("POST", `/api/agents/${second.agentId}/seen`));
    // Opening the chat counts as seeing it.
    await server.events.snapshot(`agent:${first.agentId}`);
    expect(await kinds()).toEqual([]);

    // The reply to a new message sets it again, and it is stored.
    await json(await prompt(first.agentId, "again"));
    await until(async () => (await kinds()).includes("finished first"));
    expect(
      server.store.get<{ waiting_since: number | null }>(
        "SELECT waiting_since FROM agents_agents WHERE id = ?",
        first.agentId,
      )?.waiting_since,
    ).toBeTypeOf("number");
  });

  it("drops a finished agent as soon as the user sends it a message", async () => {
    const { agentId } = await makeAgent("busy");
    await json(await prompt(agentId, "one"));
    await until(async () => (await kinds()).includes("finished busy"));
    await json(await prompt(agentId, "slow:300"));
    expect(await kinds()).toEqual([]);
  });

  // Home's Running panel shows one row per workspace, so the inbox picks the chat that says most about its work.
  it("shows one running row per workspace, and picks a working stage over the pipeline worker", async () => {
    const { agentId, workspaceId } = await makeAgent("lane");
    // The workspace's pipeline runs on a stage chat, and it works first (R6).
    const stage = startStage(workspaceId);
    await until(async () => agentsApi.get(stage.id).status === "busy");
    // Its worker chat ends its own run last and then waits for that stage, so its item is the newest one the
    // workspace has. The row still shows the stage chat that works.
    await json(await prompt(agentId, "one"));
    await until(async () => (await kinds()).includes("finished lane"));
    agentsApi.setWorkingFor(agentId, "pipeline 7: worker");

    const rows = (await inbox()).running;
    expect(rows.map((row) => row.workspace.name)).toEqual(["lane"]);
    expect(rows[0]).toMatchObject({
      agentId: stage.id,
      chat: { id: stage.id, kind: "stage" },
      status: "busy",
    });
    // The worker chat waits for the stage rather than work, so it is not another chat beside the row.
    expect(rows[0]).not.toHaveProperty("others");
  });

  it("counts the other working chats of the workspace, but not a worker that waits for its stage", async () => {
    const { agentId, workspaceId } = await makeAgent("crowd");
    await json(await prompt(agentId, "one"));
    await until(async () => (await kinds()).includes("finished crowd"));
    agentsApi.setWorkingFor(agentId, "pipeline 7: worker");
    const stage = startStage(workspaceId);
    await until(async () => agentsApi.get(stage.id).status === "busy");

    // A side chat works too, so the row says that one more chat is at work.
    const { agent: side } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents/chats", { workspaceId, kind: "side" }),
      201,
    );
    await json(await prompt(side.id, "slow:60000"));
    await until(async () => agentsApi.get(side.id).status === "busy");

    const rows = (await inbox()).running;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: stage.id, others: 1 });
  });

  it("lists the running rows newest first, even when a row stands for an older chat", async () => {
    const first = await makeAgent("first");
    const second = await makeAgent("second");
    // The first workspace's stage chat works first, so it is the oldest running chat of the three.
    const stage = startStage(first.workspaceId);
    await until(async () => agentsApi.get(stage.id).status === "busy");
    await json(await prompt(second.agentId, "slow:60000"));
    await until(async () => agentsApi.get(second.agentId).status === "busy");
    // The first workspace's worker chat waits for its stage last, so it is the newest running chat. The wait for
    // the user proves its run ended after both chats above became busy.
    await json(await prompt(first.agentId, "one"));
    await until(async () => (await kinds()).includes("finished first"));
    agentsApi.setWorkingFor(first.agentId, "pipeline 7: worker");

    // Its row shows the stage chat instead, so the row is as old as that chat: the other workspace comes first.
    const rows = (await inbox()).running;
    expect(rows.map((row) => row.workspace.name)).toEqual(["second", "first"]);
    expect(rows[1]).toMatchObject({ agentId: stage.id, chat: { kind: "stage" } });
  });

  // A stage that waits for a worker slot, and a tie of one rank, need slot pressure the fake agents never reach.
  it("picks a workspace's row in the rule's order, and counts what it leaves behind", () => {
    const worker = item("w1", "worker", "pipeline", 500);
    const stage = item("s1", "stage", "busy", 400);
    const waitingStage = item("s2", "stage", "waiting", 300);
    // A stage that works beats one that waits, and a waiting stage beats the worker chat, whatever their order.
    expect(buildWorkspaceRows([stage, waitingStage, worker])[0]).toMatchObject({ agentId: "s1" });
    expect(buildWorkspaceRows([worker, waitingStage])[0]).toMatchObject({ agentId: "s2" });
    // The item that gave its place to a better one joins the count, and a waiting worker still does not.
    expect(buildWorkspaceRows([waitingStage, stage, worker])[0]).toMatchObject({
      agentId: "s1",
      others: 1,
    });
    // A workspace shows one row even with two active worker chats, and the newest of them stands for it.
    expect(buildWorkspaceRows([worker, item("w2", "worker", "pipeline", 200)])[0]).toMatchObject({
      agentId: "w1",
    });
    // With neither a stage nor an active worker chat, the first item of the inbox order stands for the workspace.
    const side = item("c1", "side", "busy", 700);
    expect(buildWorkspaceRows([side, item("c2", "side", "starting", 600)])[0]).toMatchObject({
      agentId: "c1",
      others: 1,
    });
    // Nothing else beside the row, so no count: not for a working stage, and not for a worker that waits.
    expect(buildWorkspaceRows([stage])[0]).not.toHaveProperty("others");
    expect(buildWorkspaceRows([worker])[0]).not.toHaveProperty("others");
  });

  /** A pipeline stage chat that works, as a run starts one (R6). */
  function startStage(workspaceId: string) {
    return server.store.transaction(() => {
      const agent = agentsApi.createStage(workspaceId, { role: "reviewer", title: "Review 1" });
      agentsApi.deliver(agent.id, "slow:60000");
      return agent;
    });
  }

  function item(
    agentId: string,
    kind: ChatKind,
    status: RunningItem["status"],
    since: number,
  ): RunningItem {
    return {
      agentId,
      workspace,
      chat: { id: `chat-${agentId}`, kind, active: kind === "worker", title: `${kind} ${agentId}` },
      status,
      since,
    };
  }

  it("shows an idle chat with a running helper as running, and finished once the helper ends", async () => {
    const { agentId } = await makeAgent("helped");
    // A helper command is a prompt, which clears the wait, so each one goes in during a turn that sets it again.
    const duringTurn = async (command: string) => {
      await json(await prompt(agentId, "slow:200"));
      await json(
        await server.request("POST", `/api/agents/${agentId}/prompt`, {
          message: command,
          whileBusy: "followUp",
        }),
      );
    };

    await duringTurn("helper:run-1:scout:running");
    await until(async () => (await inbox()).running[0]?.status === "helpers");
    expect(await inbox()).toMatchObject({ items: [], running: [{ agentId, status: "helpers" }] });

    await duringTurn("helper:run-1:scout:complete");
    await until(async () => (await kinds()).includes("finished helped"));
    expect((await inbox()).running).toEqual([]);
  });

  it("does not rebuild Home when only a running helper's current tool changes", async () => {
    const { agentId } = await makeAgent("tooled");
    await json(await prompt(agentId, "hello"));
    await until(async () => (await kinds()).includes("finished tooled"));
    // A helper command is a prompt, which clears the wait; clear it first so only helper changes count.
    await json(await server.request("POST", `/api/agents/${agentId}/seen`));
    await server.events.snapshot(INBOX_TOPIC);
    const pushed = () => server.events.eventsOf(INBOX_TOPIC) as InboxEvent[];
    const running = () => pushed().at(-1)?.inbox.running.length;
    await json(await prompt(agentId, "helper:run-1:scout:running"));
    await until(async () => running() === 1);
    const before = pushed().length;
    const tools = () =>
      server.events
        .eventsOf(`agent:${agentId}`)
        .flatMap((event) =>
          (event as { type: string }).type === "children"
            ? [(event as { children: { currentTool?: string }[] }).children[0]?.currentTool]
            : [],
        );

    await json(await prompt(agentId, "helper:run-1:scout:running:read"));
    await until(async () => tools().includes("read"));
    await json(await prompt(agentId, "helper:run-1:scout:running:bash"));
    await until(async () => tools().includes("bash"));
    await json(await prompt(agentId, "helper:run-1:scout:complete"));
    await until(async () => running() === 0);
    // Only the end of the helper, which changes the running count, built Home again.
    expect(pushed().length - before).toBe(1);
  });

  it("shows an idle chat that works for a pipeline as running, and finished once that ends", async () => {
    const { agentId } = await makeAgent("piped");
    await json(await prompt(agentId, "one"));
    await until(async () => (await kinds()).includes("finished piped"));

    agentsApi.setWorkingFor(agentId, "Pipeline: review");
    await until(async () => (await inbox()).running[0]?.status === "pipeline");
    expect(await inbox()).toMatchObject({
      items: [],
      running: [{ agentId, status: "pipeline", detail: "Pipeline: review" }],
    });

    agentsApi.setWorkingFor(agentId, undefined);
    await until(async () => (await kinds()).includes("finished piped"));
    expect((await inbox()).running).toEqual([]);
  });

  // A run lane works on its stage chats, so its worker chat sits stopped (R15.1). The workspace itself works for the
  // run, which is what Home must show, as the list column does.
  it("shows a stopped worker chat as working for its workspace's pipeline run", async () => {
    const { agentId, workspaceId } = await makeAgent("gated");
    await server.events.snapshot(INBOX_TOPIC);
    const pushed = () => server.events.eventsOf(INBOX_TOPIC) as InboxEvent[];
    const row = () => pushed().at(-1)?.inbox.running[0];

    agentsApi.setWorkspaceWorkingFor(workspaceId, "Pipeline: gates");
    // Home rebuilt on the label change alone: no prompt and no chat event.
    await until(async () => row()?.status === "pipeline");
    expect(row()).toMatchObject({
      agentId,
      chat: { id: agentId, kind: "worker", active: true },
      status: "pipeline",
      detail: "Pipeline: gates",
    });
    expect((await inbox()).running).toHaveLength(1);

    agentsApi.setWorkspaceWorkingFor(workspaceId, undefined);
    await until(async () => (await inbox()).running.length === 0);
  });

  it("shows a lane's stage chat when its workspace works for a run and it has no worker chat", async () => {
    const folder = join(scratch, "stages");
    mkdirSync(folder);
    const { project } = await json<{ project: { id: string } }>(
      await server.request("POST", "/api/projects", { path: folder }),
      201,
    );
    const { workspace } = await json<{ workspace: { id: string } }>(
      await server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "stages",
        isolation: "in-place",
      }),
      201,
    );
    // The run has only its stage chat, and that chat is stopped between stages.
    const stage = server.store.transaction(() =>
      agentsApi.createStage(workspace.id, { role: "reviewer", title: "Review 1" }),
    );

    agentsApi.setWorkspaceWorkingFor(workspace.id, "Pipeline: gates");
    await until(async () => (await inbox()).running[0]?.status === "pipeline");
    expect((await inbox()).running).toMatchObject([
      {
        agentId: stage.id,
        chat: { id: stage.id, kind: "stage" },
        status: "pipeline",
        detail: "Pipeline: gates",
      },
    ]);
  });

  it("keeps a chat's own running item when its workspace also works for a run", async () => {
    const gated = await makeAgent("gated-lane");
    const owned = await makeAgent("owned-lane");
    // The second lane has a side chat that works for another run, so its own label says more than the
    // workspace's does, and the workspace gets no second row for its worker chat.
    const { agent: side } = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents/chats", {
        workspaceId: owned.workspaceId,
        kind: "side",
      }),
      201,
    );
    agentsApi.setWorkingFor(side.id, "Pipeline: review");
    agentsApi.setWorkspaceWorkingFor(gated.workspaceId, "Pipeline: gates");
    agentsApi.setWorkspaceWorkingFor(owned.workspaceId, "Pipeline: gates");

    const rows = new Map((await inbox()).running.map((row) => [row.workspace.name, row]));
    expect(rows.get("gated-lane")).toMatchObject({
      agentId: gated.agentId,
      status: "pipeline",
      detail: "Pipeline: gates",
    });
    expect(rows.get("owned-lane")).toMatchObject({
      agentId: side.id,
      status: "pipeline",
      detail: "Pipeline: review",
    });
    expect(rows.get("owned-lane")).not.toHaveProperty("others");
    expect(rows.size).toBe(2);
  });

  it("carries the router's waiting text on the running item", async () => {
    const { agentId } = await makeAgent("routed");
    await json(await prompt(agentId, "slow:60000"));
    await until(async () => (await inbox()).running.length === 1);
    await json(await prompt(agentId, "router-status:Waiting for local/qwen"));
    await until(async () => (await inbox()).running[0]?.detail === "Waiting for local/qwen");
    expect((await inbox()).running).toMatchObject([{ agentId, status: "busy" }]);
  });

  it("carries the agent's last activity on the running item", async () => {
    const { agentId } = await makeAgent("working");
    await json(await prompt(agentId, "bash:npm test"));
    await until(async () => (await inbox()).running[0]?.activity === "Running bash: npm test");
    expect((await inbox()).running).toMatchObject([
      { agentId, status: "busy", activity: "Running bash: npm test" },
    ]);

    // The tool ends, so the run does, and Home stops showing the row.
    await json(await prompt(agentId, "bash-done"));
    await until(async () => (await inbox()).running.length === 0);
  });

  it("does not show an aborted run as finished", async () => {
    const { agentId } = await makeAgent("aborted");
    await json(await prompt(agentId, "slow:400"));
    await until(async () => (await inbox()).running.length === 1);
    await json(await server.request("POST", `/api/agents/${agentId}/abort`));
    await until(async () => (await inbox()).running.length === 0);
    expect(await kinds()).toEqual([]);
  });

  it("sends the whole inbox to subscribers on subscribe and after changes", async () => {
    const { agentId } = await makeAgent("live");
    const [first] = (await server.events.snapshot(INBOX_TOPIC)) as InboxEvent[];
    expect(first).toEqual({ type: "inbox", inbox: { items: [], interrupted: [], running: [] } });

    await json(await prompt(agentId, "hi"));
    await until(async () =>
      (server.events.eventsOf(INBOX_TOPIC) as InboxEvent[]).some(
        (event) => event.inbox.items[0]?.kind === "finished",
      ),
    );
  });

  it("names the chat of each item, and drops what an older worker chat left behind", async () => {
    const { agentId, workspaceId } = await makeAgent("switch");
    await json(await prompt(agentId, "one"));
    await until(async () => (await kinds()).includes("finished switch"));
    expect((await inbox()).items[0]).toMatchObject({
      chat: { id: agentId, kind: "worker", active: true, title: "one" },
    });

    await json(
      await server.request("POST", "/api/agents/chats", { workspaceId, kind: "worker" }),
      201,
    );
    await until(async () => (await kinds()).length === 0);
  });

  it("answers 404 for an unknown question", async () => {
    const response = await server.request("POST", "/api/attention/questions/nope/answer", {
      answer: "x",
    });
    expect(response.status).toBe(404);
  });
});

describe("Home sources (ADR 0155)", () => {
  const overdue: HomeNotice = {
    id: "card-1",
    at: 5_000,
    title: "Overdue: Ship it",
    detail: "Due 2026-11-01",
    href: "#/board/card-1",
  };

  it("shows what a source reports, with its link, and drops it when the condition clears", async () => {
    expect((await inbox()).items).toEqual([]);
    notices = [overdue];
    expect((await inbox()).items).toEqual([{ kind: "notice", source: "test-source", ...overdue }]);
    notices = [];
    expect((await inbox()).items).toEqual([]);
  });

  it("sorts a notice among the other items by its time", async () => {
    const { agentId } = await makeAgent("mixed");
    await json(await prompt(agentId, "one"));
    await until(async () => (await kinds()).includes("finished mixed"));
    notices = [
      { ...overdue, id: "new", title: "Newer", at: 9_000_000_000_000 },
      { ...overdue, id: "old", title: "Older", at: 1 },
    ];
    expect(await kinds()).toEqual(["notice Newer", "finished mixed", "notice Older"]);
  });

  it("keeps the rest of Home when a source throws", async () => {
    notices = [overdue];
    broken = true;
    expect((await inbox()).items).toMatchObject([{ kind: "notice", id: "card-1" }]);
  });

  it("pushes the inbox to subscribers when a source says it changed", async () => {
    await server.events.snapshot(INBOX_TOPIC);
    notices = [overdue];
    homeItems.changed();
    const kindsPushed = () =>
      (server.events.eventsOf(INBOX_TOPIC) as InboxEvent[]).flatMap((event) =>
        event.inbox.items.map((item) => item.kind),
      );
    await until(async () => kindsPushed().includes("notice"));
  });

  it("does not let an older, slower inbox build overwrite a newer one", async () => {
    await server.events.snapshot(INBOX_TOPIC);
    sourceReads = 0;
    const pushed = () => server.events.eventsOf(INBOX_TOPIC) as InboxEvent[];
    const noticeIds = () =>
      pushed().flatMap((event) =>
        event.inbox.items.flatMap((item) => (item.kind === "notice" ? [item.id] : [])),
      );
    let finishFirst: (value: HomeNotice[]) => void = () => {};
    heldReads = [new Promise((resolve) => (finishFirst = resolve))];
    homeItems.changed();
    await until(async () => sourceReads === 1);
    // The condition clears while the first read is out, so the second build finishes first.
    notices = [];
    homeItems.changed();
    await until(async () => pushed().length === 1);
    finishFirst([overdue]);
    // A third build ends after the first, so when it shows, the first has had its turn to publish.
    notices = [{ ...overdue, id: "last" }];
    homeItems.changed();
    await until(async () => noticeIds().includes("last"));
    expect(noticeIds()).toEqual(["last"]);
  });
});

describe("approvals (ADR 0100)", () => {
  const file = (agentId: string, workspaceId: string, model = "big") =>
    approvals.file(
      { agentId, workspaceId },
      { kind: "test-gate", title: `Use ${model}`, reason: "Hard task", subject: { model } },
    );

  it("checks the subject and the kind when filed, and shows the approval on Home", async () => {
    const { agentId, workspaceId } = await makeAgent("gates");
    expect(() =>
      approvals.file(
        { agentId, workspaceId },
        { kind: "test-gate", title: "x", reason: "y", subject: { model: 3 } },
      ),
    ).toThrow("Invalid test-gate approval");
    expect(() =>
      approvals.file(
        { agentId, workspaceId },
        { kind: "nope", title: "x", reason: "y", subject: {} },
      ),
    ).toThrow(ApiError);
    const approval = file(agentId, workspaceId);
    expect(await inbox()).toMatchObject({
      items: [{ kind: "approval", agentId, approval: { id: approval.id, state: "open" } }],
    });
  });

  it("keeps the approval open when carrying it out fails, and refuses a second approve meanwhile", async () => {
    const { agentId, workspaceId } = await makeAgent("gates");
    const approval = file(agentId, workspaceId);
    gate.fail = true;
    const failed = await server.request("POST", `/api/attention/approvals/${approval.id}/approve`);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: { code: "gate_failed" } });
    expect((await inbox()).items.map((item) => item.kind)).toEqual(["approval"]);

    gate.fail = false;
    gate.hold = new Promise((resolve) => {
      gate.release = resolve;
    });
    const first = server.request("POST", `/api/attention/approvals/${approval.id}/approve`, {
      subject: { model: "bigger" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await server.request("POST", `/api/attention/approvals/${approval.id}/approve`);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "approval_deciding" } });
    gate.release?.();
    const decided = await json<{ approval: Approval }>(await first);
    expect(decided.approval).toMatchObject({
      state: "approved",
      subject: { model: "bigger" },
      outcome: "Switched to bigger.",
    });
    expect(gate.approved).toEqual([{ model: "bigger" }]);
    // The asking agent hears the outcome.
    await until(async () =>
      server.events.eventsOf(`agent:${agentId}`).some((event) => {
        const pi = (
          event as { type: string; event?: { type: string; message?: { content?: unknown } } }
        ).event;
        return (
          pi?.type === "message_end" &&
          String(pi.message?.content).includes("Outcome: Switched to bigger.")
        );
      }),
    );
    await until(async () => (await inbox()).items.every((item) => item.kind !== "approval"));
    const decline = await server.request("POST", `/api/attention/approvals/${approval.id}/decline`);
    expect(decline.status).toBe(409);
  });

  it("runs decided with the decided approval on approve and on decline", async () => {
    const { agentId, workspaceId } = await makeAgent("gates");
    const approved = file(agentId, workspaceId);
    await json(
      await server.request("POST", `/api/attention/approvals/${approved.id}/approve`, {
        subject: { model: "bigger" },
      }),
    );
    const declined = file(agentId, workspaceId, "other");
    await json(await server.request("POST", `/api/attention/approvals/${declined.id}/decline`, {}));

    expect(gate.decided).toEqual([
      { subject: { model: "bigger" }, state: "approved", approved: true },
      { subject: { model: "other" }, state: "declined", approved: false },
    ]);
  });

  it("keeps the approval open when decided throws", async () => {
    const { agentId, workspaceId } = await makeAgent("gates");
    const approval = file(agentId, workspaceId);
    gate.failDecided = true;

    const approve = await server.request("POST", `/api/attention/approvals/${approval.id}/approve`);
    expect(approve.status).toBe(409);
    expect(await approve.json()).toMatchObject({ error: { code: "decided_failed" } });
    const decline = await server.request(
      "POST",
      `/api/attention/approvals/${approval.id}/decline`,
      {},
    );
    expect(decline.status).toBe(409);
    expect(await decline.json()).toMatchObject({ error: { code: "decided_failed" } });

    const stored = await json<{ approval: Approval }>(
      await server.request("GET", `/api/attention/approvals/${approval.id}`),
    );
    expect(stored.approval).toMatchObject({ state: "open" });
    expect(stored.approval.decidedAt).toBeUndefined();
    expect(gate.decided).toEqual([]);

    gate.failDecided = false;
    await json(await server.request("POST", `/api/attention/approvals/${approval.id}/decline`, {}));
    expect(gate.decided).toMatchObject([{ approved: false }]);
  });
});

describe("Home interrupted work", () => {
  it("lists a job a restart interrupted, and drops it after a retry", async () => {
    const home = join(scratch, "restart-home");
    mkdirSync(home);
    let started!: () => void;
    const stepStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    // The step never settles, as an agent turn that the restart cuts off.
    const hang = new Promise<void>(() => {});
    const jobModule: ServerModule = {
      id: "interrupt-test",
      requires: [],
      core: false,
      setup(host) {
        host.jobs.define("interrupt-test.x", [
          {
            name: "turn",
            agentTurn: true,
            async run() {
              started();
              await hang;
              return {};
            },
          },
        ]);
      },
    };
    const open = async (firstId?: number) => {
      const own = createAgentsModule({
        pi: { command: process.execPath, args: [FAKE_PI] },
        resourceArgs: async () => ["--no-extensions"],
        roleDefaults: async () => ({}),
        baseEnv: { PATH: process.env.PATH },
        idleStopMs: 60_000,
        startTimeoutMs: 5_000,
      });
      const opened = await createTestServer(
        [
          projectsModule,
          vcsGitModule,
          vcsFolderModule,
          workspacesModule,
          own,
          attentionModule,
          jobModule,
        ],
        { home, ...(firstId ? { firstId } : {}) },
      );
      return { opened, own };
    };

    const first = await open();
    const id = first.opened.services.jobs.start("interrupt-test.x", {});
    await stepStarted;
    first.opened.close();
    await first.own.manager().stopAll();

    const second = await open(1_000);
    try {
      const listed = await json<Inbox>(await second.opened.request("GET", "/api/attention/inbox"));
      expect(listed.interrupted).toMatchObject([
        { id, kind: "interrupt-test.x", state: "interrupted" },
      ]);
      const [snapshot] = (await second.opened.events.snapshot(INBOX_TOPIC)) as InboxEvent[];
      expect(snapshot?.inbox.interrupted.map((job) => job.id)).toEqual([id]);

      await json(await second.opened.request("POST", `/api/jobs/${id}/retry`));
      const topic = () => second.opened.events.eventsOf(INBOX_TOPIC) as InboxEvent[];
      await until(async () => topic().some((event) => event.inbox.interrupted.length === 0));
      const after = await json<Inbox>(await second.opened.request("GET", "/api/attention/inbox"));
      expect(after.interrupted).toEqual([]);
    } finally {
      await second.own.manager().stopAll();
      second.opened.close();
    }
  });
});
