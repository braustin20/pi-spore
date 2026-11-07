import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsModule } from "@pi-spore/mod-actions/server";
import { type AgentEvent, createAgentsModule } from "@pi-spore/mod-agents/server";
import { attentionModule, INBOX_TOPIC } from "@pi-spore/mod-attention/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type { ChatState, Inbox, InboxEvent, Question } from "@pi-spore/shared";
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
