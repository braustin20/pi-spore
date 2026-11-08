import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { type AgentEvent, createAgentsModule } from "@pi-spore/mod-agents/server";
import { artifactsModule } from "@pi-spore/mod-artifacts/server";
import { attentionModule, INBOX_TOPIC } from "@pi-spore/mod-attention/server";
import { cardBrief, kanbanModule } from "@pi-spore/mod-kanban/server";
import { pipelinesModule } from "@pi-spore/mod-pipelines/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { runsModule } from "@pi-spore/mod-runs/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type {
  Approval,
  ArtifactInfo,
  BridgeArtifactFile,
  BridgeArtifactList,
  Card,
  ChatState,
  Inbox,
  InboxEvent,
  Question,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeModule } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

let scratch: string;
let servers: { server: TestServer; agents: ReturnType<typeof createAgentsModule> }[];

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-bridge-")));
  servers = [];
});
afterEach(async () => {
  for (const { server, agents } of servers) {
    await agents.manager().stopAll();
    server.close();
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A server with every module the bridge needs, the fake Pi, and a real HTTP port for it to call. */
async function start(
  options: { home?: string; firstId?: number; env?: Record<string, string> } = {},
) {
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH, ...options.env },
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
      pipelinesModule,
      runsModule,
      bridgeModule,
    ],
    {
      listen: true,
      ...(options.home ? { home: options.home } : {}),
      ...(options.firstId ? { firstId: options.firstId } : {}),
    },
  );
  servers.push({ server, agents });
  return server;
}

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** A folder project with one in-place workspace and its worker. `config` is the project's config.toml. */
async function workspace(server: TestServer, name: string, config = "") {
  const folder = join(scratch, name);
  mkdirSync(join(folder, ".pi-spore"), { recursive: true });
  writeFileSync(join(folder, ".pi-spore", "config.toml"), config);
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
  return { workspaceId: workspace.id, agentId: agent.id, folder };
}

/** One more in-place workspace of the same project, with its worker chat. */
async function sibling(server: TestServer, of: string, name: string) {
  const { workspace: parent } = await json<{ workspace: { projectId: string } }>(
    await server.request("GET", `/api/workspaces/${of}`),
  );
  const { workspace } = await json<{ workspace: { id: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId: parent.projectId,
      name,
      isolation: "in-place",
    }),
    201,
  );
  const { agent } = await json<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
    201,
  );
  return { workspaceId: workspace.id, agentId: agent.id };
}

/** Calls a bridge route as an agent process would, with its own token. */
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

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function chat(server: TestServer, agentId: string): Promise<string[]> {
  const [snapshot] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
  if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
  return (snapshot.chat as ChatState).messages.map((message) =>
    typeof message.content === "string"
      ? `${message.role}: ${message.content}`
      : `${message.role}: ${(message.content as { text?: string }[]).map((block) => block.text).join("")}`,
  );
}

const inbox = async (server: TestServer) =>
  json<Inbox>(await server.request("GET", "/api/attention/inbox"));

/** The agent's messages as seen live, without a chat snapshot, which would count as the user opening the chat. */
const said = (server: TestServer, agentId: string) =>
  (server.events.eventsOf(`agent:${agentId}`) as AgentEvent[]).flatMap((event) => {
    const pi =
      event.type === "pi"
        ? (event.event as { type: string; message?: { role: string; content: unknown } })
        : undefined;
    if (pi?.type !== "message_end" || !pi.message) return [];
    const { role, content } = pi.message;
    return [
      `${role}: ${typeof content === "string" ? content : (content as { text?: string }[]).map((block) => block.text).join("")}`,
    ];
  });

const statuses = (server: TestServer, agentId: string) =>
  (server.events.eventsOf(`agent:${agentId}`) as AgentEvent[]).flatMap((event) =>
    event.type === "status" ? [event.status] : [],
  );

describe("request_human_input", () => {
  it("files a question from the agent, shows it on Home, and delivers the answer as a new message", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "colors");

    await json(
      await server.request("POST", `/api/agents/${agentId}/prompt`, {
        message: "ask:Which color?",
      }),
    );
    await until(async () => (await inbox(server)).items.some((item) => item.kind === "question"));

    const [item] = (await inbox(server)).items;
    expect(item).toMatchObject({
      kind: "question",
      agentId,
      workspace: { id: workspaceId, name: "colors", projectName: "colors", state: "active" },
      chat: { id: agentId, kind: "worker", active: true, title: "ask:Which color?" },
      question: { question: "Which color?", state: "open" },
    });
    const question = (item as { question: Question }).question;
    await until(() => said(server, agentId).at(-1) === `assistant: asked: ${question.id}`);
    // The open question already says why the agent stopped: no second "finished" item.
    expect((await inbox(server)).items).toHaveLength(1);

    await json(
      await server.request("POST", `/api/attention/questions/${question.id}/answer`, {
        answer: "Blue",
      }),
    );
    const message = [
      `The user answered your question (request_human_input, question ${question.id}).`,
      "",
      "Question: Which color?",
      "",
      "Answer: Blue",
    ].join("\n");
    await until(() => said(server, agentId).at(-1) === `assistant: echo: ${message}`);
    expect(said(server, agentId).at(-2)).toBe(`user: ${message}`);

    // Answered: the question leaves Home, and the reply waits for the user instead.
    await until(async () => (await inbox(server)).items[0]?.kind === "finished");
    expect((await inbox(server)).items.map((entry) => entry.kind)).toEqual(["finished"]);
    const again = await server.request("POST", `/api/attention/questions/${question.id}/answer`, {
      answer: "Red",
    });
    expect(again.status).toBe(409);

    // Live Home updates went out over the event hub.
    const published = server.events.eventsOf(INBOX_TOPIC) as InboxEvent[];
    expect(
      published.some((event) => event.inbox.items.some((entry) => entry.kind === "question")),
    ).toBe(true);

    // Opening the chat counts as seeing the reply.
    await chat(server, agentId);
    await until(async () => (await inbox(server)).items.length === 0);
  });

  it("returns the first question to a replayed tool call", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "replay");
    const call = asAgent(server, agentId, workspaceId);

    const first = await json<{ question: Question }>(
      await call("POST", "questions", { question: "Ship it?", choices: ["yes", "no"] }, "toolu_9"),
      201,
    );
    const replay = await json<{ question: Question }>(
      await call("POST", "questions", { question: "Ship it?", choices: ["yes", "no"] }, "toolu_9"),
      201,
    );

    expect(replay.question.id).toBe(first.question.id);
    expect(first.question).toMatchObject({ choices: ["yes", "no"], workspaceId, agentId });
    expect((await inbox(server)).items).toHaveLength(1);
  });

  it("rejects a bad question with a clear 400", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "bad");
    const response = await asAgent(server, agentId, workspaceId)("POST", "questions", {
      question: "",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      "/question",
    );
  });
});

describe("questions of older worker chats (ADR 0033)", () => {
  it("close when the user starts a new worker chat, and cannot be answered", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "moved-on");
    const { question } = await json<{ question: Question }>(
      await asAgent(server, agentId, workspaceId)("POST", "questions", { question: "Red?" }),
      201,
    );
    const side = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents/chats", { workspaceId, kind: "side" }),
      201,
    );
    const sideQuestion = await json<{ question: Question }>(
      await asAgent(
        server,
        side.agent.id,
        workspaceId,
        true,
      )("POST", "questions", {
        question: "Why?",
      }),
      201,
    );

    await json(
      await server.request("POST", "/api/agents/chats", { workspaceId, kind: "worker" }),
      201,
    );

    // The side chat's question stays; the old worker chat's question is closed.
    expect(
      (await inbox(server)).items.map((item) => item.kind === "question" && item.question.id),
    ).toEqual([sideQuestion.question.id]);
    const closed = await json<{ question: Question }>(
      await server.request("GET", `/api/attention/questions/${question.id}`),
    );
    expect(closed.question.state).toBe("closed");
    const answer = await server.request("POST", `/api/attention/questions/${question.id}/answer`, {
      answer: "Yes",
    });
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ error: { code: "question_closed" } });
    expect(server.store.get("SELECT * FROM agents_deliveries")).toBeUndefined();
  });

  it("an answer still pending when its chat became inactive waits until the chat is active again", async () => {
    const home = join(scratch, "home");
    const first = await start({ home, env: { FAKE_PI_HANG: "1" } });
    const { agentId, workspaceId } = await workspace(first, "later");
    const { question } = await json<{ question: Question }>(
      await asAgent(first, agentId, workspaceId)("POST", "questions", { question: "Left?" }),
      201,
    );
    await json(
      await first.request("POST", `/api/attention/questions/${question.id}/answer`, {
        answer: "Left",
      }),
    );
    await until(() => statuses(first, agentId).includes("failed"));
    const { agent: fresh } = await json<{ agent: { id: string } }>(
      await first.request("POST", "/api/agents/chats", { workspaceId, kind: "worker" }),
      201,
    );
    const entry = servers.pop();
    await entry?.agents.manager().stopAll();
    entry?.server.close();

    // After the restart the old chat is inactive: its delivery waits and Pi does not start.
    const second = await start({ home, firstId: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(statuses(second, agentId)).toEqual([]);
    // Not even tried: the one attempt is the failed start on the first server.
    expect(
      second.store.get<{ state: string; attempts: number }>(
        "SELECT state, attempts FROM agents_deliveries",
      ),
    ).toEqual({ state: "pending", attempts: 1 });

    await json(await second.request("POST", `/api/agents/${agentId}/activate`));
    await until(
      async () => (await chat(second, agentId)).at(-1)?.endsWith("Answer: Left") ?? false,
    );
    expect(second.store.get<{ state: string }>("SELECT state FROM agents_deliveries")?.state).toBe(
      "done",
    );
    expect(statuses(second, fresh.id)).toEqual([]);
  });
});

describe("deliveries", () => {
  it("keep an answer while the workspace is parked and deliver it on resume", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "parked");
    const { question } = await json<{ question: Question }>(
      await asAgent(server, agentId, workspaceId)("POST", "questions", { question: "Go on?" }),
      201,
    );
    await json(await server.request("POST", `/api/workspaces/${workspaceId}/park`));

    await json(
      await server.request("POST", `/api/attention/questions/${question.id}/answer`, {
        answer: "Yes",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(statuses(server, agentId)).toEqual([]);
    expect(server.store.get<{ state: string }>("SELECT state FROM agents_deliveries")?.state).toBe(
      "pending",
    );

    await json(await server.request("POST", `/api/workspaces/${workspaceId}/resume`));
    await until(async () => (await chat(server, agentId)).at(-1)?.endsWith("Answer: Yes") ?? false);
    expect(server.store.get<{ state: string }>("SELECT state FROM agents_deliveries")?.state).toBe(
      "done",
    );
  });

  it("survive a restart: a delivery that failed is sent when the server starts again", async () => {
    const home = join(scratch, "home");
    const first = await start({ home, env: { FAKE_PI_HANG: "1" } });
    const { agentId, workspaceId } = await workspace(first, "restart");
    const { question } = await json<{ question: Question }>(
      await asAgent(first, agentId, workspaceId)("POST", "questions", { question: "Which way?" }),
      201,
    );
    await json(
      await first.request("POST", `/api/attention/questions/${question.id}/answer`, {
        answer: "Left",
      }),
    );
    // The agent never starts on this server, so the delivery fails and stays pending.
    await until(() => statuses(first, agentId).includes("failed"));
    expect(
      first.store.get<{ state: string; attempts: number }>(
        "SELECT state, attempts FROM agents_deliveries",
      ),
    ).toEqual({ state: "pending", attempts: 1 });
    const entry = servers.pop();
    await entry?.agents.manager().stopAll();
    entry?.server.close();

    const second = await start({ home, firstId: 1_000 });
    await until(
      async () => (await chat(second, agentId)).at(-1)?.endsWith("Answer: Left") ?? false,
    );
    expect(second.store.get<{ state: string }>("SELECT state FROM agents_deliveries")?.state).toBe(
      "done",
    );
  });
});

describe("check and run_action", () => {
  const config = (code: number) =>
    `[actions.check]\nrun = ["${process.execPath}", "-e", "console.log('a.ts: error'); process.exit(${code})"]\n`;

  it("run the project's action in the agent's workspace and return its outcome and log", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "checks", config(2));
    const call = asAgent(server, agentId, workspaceId);

    const { run } = await json<{ run: { id: string; trigger: string } }>(
      await call("POST", "runs", { action: "check" }, "toolu_c"),
      201,
    );
    expect(run.trigger).toBe("agent");
    const ended = await json<{ run: { status: string; exitCode: number } }>(
      await call("GET", `runs/${run.id}?wait=5000`),
    );
    expect(ended.run).toMatchObject({ status: "failed", exitCode: 2 });
    const log = await json<{ text: string; truncated: boolean }>(
      await call("GET", `runs/${run.id}/log`),
    );
    expect(log.text).toContain("a.ts: error");
    expect(log.truncated).toBe(false);

    // The same tool call again gets the first run, not a second one.
    const replay = await json<{ run: { id: string } }>(
      await call("POST", "runs", { action: "check" }, "toolu_c"),
      201,
    );
    expect(replay.run.id).toBe(run.id);
  });

  it("say clearly when the project has no such action", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "none");
    const response = await asAgent(server, agentId, workspaceId)("POST", "runs", {
      action: "check",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "action_not_found" } });
  });

  it("refuse a read-only side chat", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "side", config(0));
    const response = await asAgent(
      server,
      agentId,
      workspaceId,
      true,
    )("POST", "runs", {
      action: "check",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "read_only_chat" } });
  });

  it("let an agent reach only its own workspace's runs", async () => {
    const server = await start();
    const mine = await workspace(server, "mine", config(0));
    const theirs = await workspace(server, "theirs", config(0));
    const { run } = await json<{ run: { id: string } }>(
      await asAgent(server, mine.agentId, mine.workspaceId)("POST", "runs", { action: "check" }),
      201,
    );

    const other = asAgent(server, theirs.agentId, theirs.workspaceId);
    expect((await other("GET", `runs/${run.id}`)).status).toBe(404);
    expect((await other("GET", `runs/${run.id}/log`)).status).toBe(404);
    expect((await other("POST", `runs/${run.id}/cancel`, {})).status).toBe(404);
    // The run must end before the store closes.
    await asAgent(server, mine.agentId, mine.workspaceId)("GET", `runs/${run.id}?wait=5000`);
    // An agent token opens no user routes.
    expect(
      (
        await server.request("GET", "/api/agents", undefined, {
          "x-pi-spore-token": "",
          authorization: `Bearer ${server.agentTokens.issue({ agentId: mine.agentId, workspaceId: mine.workspaceId })}`,
        })
      ).status,
    ).toBe(401);
  });
});

describe("cards from agents (ADR 0100)", () => {
  it("sets and clears a card's model (ADR 0120)", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "plans");
    const call = asAgent(server, agentId, workspaceId);
    const { card } = await json<{ card: Card }>(
      await call("POST", "cards", { title: "Phase 1", model: "fake/card-model" }),
      201,
    );
    expect(card.model).toBe("fake/card-model");
    const cleared = await json<{ card: Card }>(
      await call("POST", `cards/${card.id}`, { model: null }),
    );
    expect(cleared.card.model).toBeUndefined();
    expect((await call("POST", "cards", { title: "Bad", model: "bad" })).status).toBe(400);
  });

  it("adds, lists, and changes cards of the agent's own project, and records the agent", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "plans");
    const call = asAgent(server, agentId, workspaceId);

    const { card: one } = await json<{ card: Card }>(
      await call("POST", "cards", { title: "Phase 1", labels: ["plan:x"] }, "toolu_a1"),
      201,
    );
    // A replayed tool call gets the first card, not a second one.
    const replay = await json<{ card: Card }>(
      await call("POST", "cards", { title: "Phase 1", labels: ["plan:x"] }, "toolu_a1"),
      201,
    );
    expect(replay.card.id).toBe(one.id);
    const { card: two } = await json<{ card: Card }>(
      await call(
        "POST",
        "cards",
        { title: "Phase 2", labels: ["plan:x"], blockedBy: [one.id] },
        "toolu_a2",
      ),
      201,
    );
    const author = { agentId, workspaceId };
    expect(two).toMatchObject({
      blocked: true,
      createdBy: author,
      changedBy: author,
      blockedBy: [{ kind: "card", id: one.id }],
    });
    expect(two.projectId).toBe(one.projectId);

    const changed = await json<{ card: Card }>(
      await call("POST", `cards/${one.id}`, { column: "ready", body: "Do it" }, "toolu_a3"),
    );
    expect(changed.card).toMatchObject({ column: "ready", body: "Do it", changedBy: author });
    const { history } = await json<{ history: { reason: string }[] }>(
      await server.request("GET", `/api/kanban/cards/${one.id}`),
    );
    expect(history.map((move) => move.reason)).toEqual(["created", "agent"]);

    const listed = await json<{ cards: Card[]; workspaces: unknown[] }>(
      await call("GET", "cards?label=plan:x"),
    );
    expect(listed.cards.map((card) => card.title)).toEqual(["Phase 2", "Phase 1"]);
    expect(listed.workspaces).toEqual([{ id: workspaceId, name: "plans", current: true }]);

    // A change by the user clears the agent's mark.
    const byUser = await json<{ card: Card }>(
      await server.request("PATCH", `/api/kanban/cards/${one.id}`, { title: "Phase one" }),
    );
    expect(byUser.card.changedBy).toBeUndefined();
    expect(byUser.card.createdBy).toEqual(author);
  });

  it("keeps an agent away from other projects' cards and from cards with no project", async () => {
    const server = await start();
    const mine = await workspace(server, "mine");
    const theirs = await workspace(server, "theirs");
    const { card: foreign } = await json<{ card: Card }>(
      await asAgent(server, theirs.agentId, theirs.workspaceId)("POST", "cards", {
        title: "Theirs",
      }),
      201,
    );
    const { card: loose } = await json<{ card: Card }>(
      await server.request("POST", "/api/kanban/cards", { title: "No project" }),
      201,
    );
    const call = asAgent(server, mine.agentId, mine.workspaceId);
    for (const id of [foreign.id, loose.id]) {
      const changed = await call("POST", `cards/${id}`, { title: "Mine now" });
      expect(changed.status).toBe(404);
      expect(await changed.json()).toMatchObject({ error: { code: "card_not_found" } });
      expect(
        (
          await call("POST", `cards/${id}/start`, {
            target: { kind: "new", isolation: "new" },
            reason: "x",
          })
        ).status,
      ).toBe(404);
    }
    const blocked = await call("POST", "cards", { title: "Mine", blockedBy: [foreign.id] });
    expect(blocked.status).toBe(404);
    expect((await json<{ cards: Card[] }>(await call("GET", "cards"))).cards).toEqual([]);
  });

  it("refuses card changes from a read-only side chat", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "side-cards");
    const call = asAgent(server, agentId, workspaceId, true);
    const added = await call("POST", "cards", { title: "Nope" });
    expect(added.status).toBe(403);
    expect(await added.json()).toMatchObject({ error: { code: "read_only_chat" } });
    expect((await call("GET", "cards")).status).toBe(200);
  });
});

describe("artifacts from agents (ADR 0070)", () => {
  it("writes, reads, and lists in both scopes, and records the agent", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "art-own");
    const call = asAgent(server, agentId, workspaceId);

    const { artifact: plan } = await json<{ artifact: ArtifactInfo }>(
      await call("POST", "artifacts", { scope: "workspace", path: "plans/a.md", content: "# A" }),
    );
    expect(plan).toMatchObject({ scope: "workspace", ownerId: workspaceId, writtenBy: agentId });
    const { artifact: note } = await json<{ artifact: ArtifactInfo }>(
      await call("POST", "artifacts", { scope: "project", path: "notes.md", content: "shared" }),
    );
    expect(note).toMatchObject({ scope: "project", writtenBy: agentId });

    const list = await json<BridgeArtifactList>(await call("GET", "artifacts"));
    expect(list.workspace.map((entry) => entry.path)).toEqual(["plans/a.md"]);
    expect(list.project.map((entry) => entry.path)).toEqual(["notes.md"]);

    const read = await json<BridgeArtifactFile>(
      await call("GET", "artifacts/file?scope=workspace&path=plans%2Fa.md"),
    );
    expect(read).toMatchObject({ content: "# A", artifact: { path: "plans/a.md" } });
    const shared = await json<BridgeArtifactFile>(
      await call("GET", "artifacts/file?scope=project&path=notes.md"),
    );
    expect(shared.content).toBe("shared");
  });

  it("keeps an agent to its own workspace and project, and shares the project's files", async () => {
    const server = await start();
    const a = await workspace(server, "art-a");
    const a2 = await sibling(server, a.workspaceId, "art-a2");
    const b = await workspace(server, "art-b");
    const callA = asAgent(server, a.agentId, a.workspaceId);
    const callA2 = asAgent(server, a2.agentId, a2.workspaceId);
    const callB = asAgent(server, b.agentId, b.workspaceId);

    await json(
      await callB("POST", "artifacts", { scope: "workspace", path: "secret.md", content: "b" }),
    );
    await json(
      await callB("POST", "artifacts", { scope: "project", path: "b-note.md", content: "b" }),
    );
    await json(
      await callA2("POST", "artifacts", { scope: "project", path: "p-note.md", content: "p" }),
    );

    const list = await json<BridgeArtifactList>(await callA("GET", "artifacts"));
    expect(list.workspace).toEqual([]);
    expect(list.project.map((entry) => entry.path)).toEqual(["p-note.md"]);
    for (const scope of ["workspace", "project"]) {
      for (const path of ["secret.md", "b-note.md"]) {
        const read = await callA("GET", `artifacts/file?scope=${scope}&path=${path}`);
        expect(read.status).toBe(404);
      }
    }
    expect(
      (
        await json<BridgeArtifactFile>(
          await callA("GET", "artifacts/file?scope=project&path=p-note.md"),
        )
      ).content,
    ).toBe("p");
    // Another workspace of the same project does not see this workspace's own files.
    expect((await json<BridgeArtifactList>(await callA2("GET", "artifacts"))).workspace).toEqual(
      [],
    );
  });

  it("answers a bad scope with 400", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "art-scope");
    const call = asAgent(server, agentId, workspaceId);
    for (const query of ["path=a.md", "scope=other&path=a.md"]) {
      const response = await call("GET", `artifacts/file?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "bad_query" } });
    }
  });

  it("lets a read-only side chat list and read, and refuses its writes", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "art-side");
    await json(
      await asAgent(server, agentId, workspaceId)("POST", "artifacts", {
        scope: "workspace",
        path: "a.md",
        content: "hi",
      }),
    );
    const call = asAgent(server, agentId, workspaceId, true);
    expect((await json<BridgeArtifactList>(await call("GET", "artifacts"))).workspace).toHaveLength(
      1,
    );
    expect(
      (
        await json<BridgeArtifactFile>(
          await call("GET", "artifacts/file?scope=workspace&path=a.md"),
        )
      ).content,
    ).toBe("hi");
    const written = await call("POST", "artifacts", {
      scope: "workspace",
      path: "b.md",
      content: "no",
    });
    expect(written.status).toBe(403);
    expect(await written.json()).toMatchObject({ error: { code: "read_only_chat" } });
  });

  it("returns the first answer to a replayed write and writes once", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "art-replay");
    const call = asAgent(server, agentId, workspaceId);
    const body = (content: string) => ({ scope: "workspace", path: "r.md", content });
    const read = async () =>
      (
        await json<BridgeArtifactFile>(
          await call("GET", "artifacts/file?scope=workspace&path=r.md"),
        )
      ).content;

    const first = await json<{ artifact: ArtifactInfo }>(
      await call("POST", "artifacts", body("first"), "toolu_a1"),
    );
    await json(await call("POST", "artifacts", body("second"), "toolu_a2"));
    // The server refuses a reused key with another body, so the replay repeats the first call. A real second
    // write would put "first" back over "second".
    const replay = await json<{ artifact: ArtifactInfo }>(
      await call("POST", "artifacts", body("first"), "toolu_a1"),
    );

    expect(replay).toEqual(first);
    expect(await read()).toBe("second");
  });

  it("says a file that is not UTF-8 text is not text", async () => {
    const server = await start();
    const { agentId, workspaceId } = await workspace(server, "art-binary");
    const call = asAgent(server, agentId, workspaceId);
    await json(
      await call("POST", "artifacts", { scope: "workspace", path: "bad.md", content: "x" }),
    );
    const file = join(server.paths.artifacts, "workspaces", workspaceId, "bad.md");
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    expect(readFileSync(file)).toHaveLength(4);

    const response = await call("GET", "artifacts/file?scope=workspace&path=bad.md");
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: "not_text", message: expect.stringContaining("Artifacts tab") },
    });
  });
});

describe("starting a card by an agent (ADR 0100)", () => {
  /** A project with the asking agent's workspace, a related workspace, and a card. */
  async function setUp() {
    const server = await start();
    const asker = await workspace(server, "planner");
    const related = await sibling(server, asker.workspaceId, "crafting");
    const call = asAgent(server, asker.agentId, asker.workspaceId);
    const { card: first } = await json<{ card: Card }>(
      await call("POST", "cards", { title: "Phase 1", body: "Build the base." }),
      201,
    );
    return { server, asker, related, call, first };
  }

  const fileStart = async (
    call: ReturnType<typeof asAgent>,
    cardId: string,
    target: unknown,
    receipt?: string,
  ) =>
    json<{ approval: Approval }>(
      await call("POST", `cards/${cardId}/start`, { target, reason: "Phase 1 is next" }, receipt),
      201,
    );

  it("files an approval on Home and starts nothing until the user approves", async () => {
    const { server, asker, related, call, first } = await setUp();
    const { approval } = await fileStart(
      call,
      first.id,
      { kind: "existing", workspaceId: related.workspaceId },
      "toolu_s1",
    );
    expect(approval).toMatchObject({
      kind: "card-start",
      agentId: asker.agentId,
      workspaceId: asker.workspaceId,
      title: 'Start card "Phase 1" in the workspace "crafting"',
      reason: "Phase 1 is next",
      state: "open",
      subject: { cardId: first.id, target: { kind: "existing", workspaceId: related.workspaceId } },
    });
    // A replayed tool call gets the same approval.
    const replay = await fileStart(
      call,
      first.id,
      { kind: "existing", workspaceId: related.workspaceId },
      "toolu_s1",
    );
    expect(replay.approval.id).toBe(approval.id);

    const items = (await inbox(server)).items;
    expect(items.map((item) => item.kind)).toEqual(["approval"]);
    expect(items[0]).toMatchObject({ agentId: asker.agentId, approval: { id: approval.id } });
    const { card } = await json<{ card: Card }>(
      await server.request("GET", `/api/kanban/cards/${first.id}`),
    );
    expect(card.column).toBe("backlog");
    expect(card.workspaceId).toBeUndefined();

    // The agent cannot decide its own approval: the attention routes take only the user's token, and no bridge
    // route decides one.
    const token = server.agentTokens.issue({
      agentId: asker.agentId,
      workspaceId: asker.workspaceId,
    });
    const asAgentToken = { "x-pi-spore-token": "", authorization: `Bearer ${token}` };
    expect(
      (
        await server.request(
          "POST",
          `/api/attention/approvals/${approval.id}/approve`,
          {},
          asAgentToken,
        )
      ).status,
    ).toBe(401);
    expect((await call("POST", `approvals/${approval.id}/approve`, {})).status).toBe(404);
  });

  it("starts the work on approve, with a changed target, and tells the asking agent", async () => {
    const { server, asker, related, call, first } = await setUp();
    const { approval } = await fileStart(call, first.id, { kind: "new", isolation: "in-place" });

    // The user picks the related workspace instead of a new one.
    const decided = await json<{ approval: Approval }>(
      await server.request("POST", `/api/attention/approvals/${approval.id}/approve`, {
        subject: {
          cardId: first.id,
          target: { kind: "existing", workspaceId: related.workspaceId },
        },
      }),
    );
    expect(decided.approval).toMatchObject({
      state: "approved",
      subject: { target: { kind: "existing", workspaceId: related.workspaceId } },
    });
    const { card } = await json<{ card: Card }>(
      await server.request("GET", `/api/kanban/cards/${first.id}`),
    );
    expect(card).toMatchObject({ column: "in-progress", workspaceId: related.workspaceId });

    const brief = cardBrief(
      card,
      "The user approved starting it here, as an agent asked. The agent's reason: Phase 1 is next",
    );
    await until(() => said(server, related.agentId).includes(`user: ${brief}`));
    const outcome = [
      `The user approved your request (approval ${approval.id}).`,
      "",
      `Request: ${approval.title}`,
      "",
      `Outcome: Card "Phase 1" (${first.id}) started in the existing workspace "crafting" (${related.workspaceId}). Its brief went to that workspace's worker chat (${related.agentId}).`,
    ].join("\n");
    await until(() => said(server, asker.agentId).includes(`user: ${outcome}`));
    expect((await inbox(server)).items.some((item) => item.kind === "approval")).toBe(false);

    const again = await server.request("POST", `/api/attention/approvals/${approval.id}/approve`);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "approval_decided" } });
  });

  it("starts a run on approve and links the card to it", async () => {
    const server = await start();
    const folder = join(scratch, "planner");
    mkdirSync(folder);
    writeFileSync(join(folder, "a.txt"), "one\n");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: folder });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const asker = await workspace(server, "planner");
    const call = asAgent(server, asker.agentId, asker.workspaceId);
    const { card: first } = await json<{ card: Card }>(
      await call("POST", "cards", { title: "Phase 1", body: "Build the base." }),
      201,
    );

    const { approval } = await fileStart(call, first.id, { kind: "run" });
    expect(approval.title).toBe('Start card "Phase 1" in a new run');
    const projectId = (
      await json<{ workspace: { projectId: string } }>(
        await server.request("GET", `/api/workspaces/${asker.workspaceId}`),
      )
    ).workspace.projectId;
    const listRuns = async () =>
      (
        await json<{ runs: { id: string; workspaceId: string; coordinatorAgentId: string }[] }>(
          await server.request("GET", `/api/runs?projectId=${projectId}`),
        )
      ).runs;
    expect(await listRuns()).toEqual([]);
    const before = await json<{ card: Card }>(
      await server.request("GET", `/api/kanban/cards/${first.id}`),
    );
    expect(before.card.column).toBe("backlog");

    await json(await server.request("POST", `/api/attention/approvals/${approval.id}/approve`));
    const [run] = await listRuns();
    if (!run) throw new Error("The approval started no run");
    const { card } = await json<{ card: Card }>(
      await server.request("GET", `/api/kanban/cards/${first.id}`),
    );
    expect(card).toMatchObject({ column: "in-progress", workspaceId: run.workspaceId });
    const brief = cardBrief(
      card,
      "The user approved starting it here, as an agent asked. The agent's reason: Phase 1 is next",
    );
    await until(() => said(server, run.coordinatorAgentId).includes(`user: ${brief}`));
  });

  it("refuses a changed card on approve and keeps the approval open", async () => {
    const { server, call, first } = await setUp();
    const { card: other } = await json<{ card: Card }>(
      await call("POST", "cards", { title: "Phase 2" }),
      201,
    );
    const { approval } = await fileStart(call, first.id, { kind: "new", isolation: "in-place" });
    const response = await server.request(
      "POST",
      `/api/attention/approvals/${approval.id}/approve`,
      { subject: { cardId: other.id, target: { kind: "new", isolation: "in-place" } } },
    );
    expect(response.status).toBe(422);
    const bad = await server.request("POST", `/api/attention/approvals/${approval.id}/approve`, {
      subject: { cardId: first.id, target: { kind: "elsewhere" } },
    });
    expect(bad.status).toBe(400);
    const { approval: still } = await json<{ approval: Approval }>(
      await server.request("GET", `/api/attention/approvals/${approval.id}`),
    );
    expect(still.state).toBe("open");
  });

  it("tells the asking agent when the user declines, with the note", async () => {
    const { server, asker, call, first } = await setUp();
    const { approval } = await fileStart(call, first.id, { kind: "new", isolation: "in-place" });
    await json(
      await server.request("POST", `/api/attention/approvals/${approval.id}/decline`, {
        note: "Not today",
      }),
    );
    const message = [
      `The user declined your request (approval ${approval.id}).`,
      "",
      `Request: ${approval.title}`,
      "",
      "The user's note: Not today",
    ].join("\n");
    await until(() => said(server, asker.agentId).includes(`user: ${message}`));
    const { card } = await json<{ card: Card }>(
      await server.request("GET", `/api/kanban/cards/${first.id}`),
    );
    expect(card.column).toBe("backlog");
    const { approvals } = await json<{ approvals: Approval[] }>(
      await server.request("GET", "/api/attention/approvals?state=declined"),
    );
    expect(approvals.map((found) => [found.id, found.outcome])).toEqual([
      [approval.id, "Not today"],
    ]);
  });

  it("says a card is blocked, and refuses parked or foreign targets when filed", async () => {
    const { server, asker, related, call, first } = await setUp();
    const { card: second } = await json<{ card: Card }>(
      await call("POST", "cards", { title: "Phase 2", blockedBy: [first.id] }),
      201,
    );
    const { approval } = await fileStart(call, second.id, { kind: "new", isolation: "new" });
    expect(approval.title).toBe(
      'Start card "Phase 2" in a new workspace (new worktree or copy) (blocked by: Phase 1)',
    );

    await json(await server.request("POST", `/api/workspaces/${related.workspaceId}/park`));
    const parked = await call("POST", `cards/${first.id}/start`, {
      target: { kind: "existing", workspaceId: related.workspaceId },
      reason: "x",
    });
    expect(parked.status).toBe(409);
    expect(await parked.json()).toMatchObject({ error: { code: "workspace_not_active" } });

    const elsewhere = await workspace(server, "elsewhere");
    const foreign = await call("POST", `cards/${first.id}/start`, {
      target: { kind: "existing", workspaceId: elsewhere.workspaceId },
      reason: "x",
    });
    expect(foreign.status).toBe(404);
    expect(asker.workspaceId).not.toBe(elsewhere.workspaceId);
  });
});
