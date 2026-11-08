import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attentionModule } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));

const DAY = 86_400_000;
const START = 1_700_000_000_000;
// The test clock ticks once per call, so a restart time is a little past a whole number of days.
const SLACK = 10_000;

let home: string;
let scratch: string;
let servers: TestServer[];
let agentModules: ReturnType<typeof createAgentsModule>[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-chat-retention-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-chat-retention-repos-")));
  servers = [];
  agentModules = [];
});
afterEach(async () => {
  for (const agents of agentModules) await agents.manager().stopAll();
  for (const server of servers) server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function start(startAt: number, firstId = 0): Promise<TestServer> {
  const agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
  });
  agentModules.push(agents);
  const server = await createTestServer(
    [projectsModule, vcsGitModule, vcsFolderModule, workspacesModule, agents, attentionModule],
    { home, startAt, firstId },
  );
  servers.push(server);
  return server;
}

/** Ends the running server, as a stop before a restart. */
const stop = async (): Promise<void> => {
  await agentModules.pop()?.manager().stopAll();
  servers.pop()?.close();
};

async function ok<T>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function makeWorkspace(server: TestServer, name: string): Promise<string> {
  const folder = join(scratch, name);
  mkdirSync(folder);
  const { project } = await ok<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await ok<{ workspace: { id: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name,
      isolation: "in-place",
    }),
    201,
  );
  return workspace.id;
}

async function newChat(
  server: TestServer,
  workspaceId: string,
  kind: "worker" | "side",
  fork?: boolean,
): Promise<string> {
  const { agent } = await ok<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents/chats", {
      workspaceId,
      kind,
      ...(fork === undefined ? {} : { fork }),
    }),
    201,
  );
  return agent.id;
}

const close = async (server: TestServer, agentId: string) =>
  ok(await server.request("POST", `/api/agents/${agentId}/close`));

/** A session file for the chat, as a started Pi would have written it. */
function giveSession(server: TestServer, workspaceId: string, agentId: string): string {
  const dir = join(server.paths.sessions, workspaceId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${agentId}.jsonl`);
  writeFileSync(file, '{"type":"session"}\n');
  server.store.run("UPDATE agents_agents SET session_file = ? WHERE id = ?", file, agentId);
  return file;
}

/** What retention must delete with a chat: a pending delivery and a question. */
function addAttention(server: TestServer, workspaceId: string, agentId: string): void {
  server.store.run(
    "INSERT INTO agents_deliveries (id, agent_id, message, state, created_at) VALUES (?, ?, 'hi', 'done', ?)",
    `delivery-${agentId}`,
    agentId,
    START,
  );
  server.store.run(
    "INSERT INTO attention_questions (id, agent_id, workspace_id, question, state, created_at) VALUES (?, ?, ?, 'Which?', 'open', ?)",
    `question-${agentId}`,
    agentId,
    workspaceId,
    START,
  );
}

const count = (server: TestServer, table: string, column: string, id: string): number =>
  server.store.all(`SELECT 1 FROM ${table} WHERE ${column} = ?`, id).length;

const agentStatus = async (server: TestServer, agentId: string): Promise<number> =>
  (await server.request("GET", `/api/agents/${agentId}`)).status;

const setDays = (days: number): void =>
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retention: { days } }));

/** A closed side chat with a session file, a delivery, and a question, then a restart `days` later. */
async function closedChatThenRestarted(days: number) {
  const first = await start(START);
  const workspaceId = await makeWorkspace(first, "notes");
  const openId = await newChat(first, workspaceId, "worker");
  const closedId = await newChat(first, workspaceId, "side");
  const file = giveSession(first, workspaceId, closedId);
  addAttention(first, workspaceId, closedId);
  addAttention(first, workspaceId, openId);
  await close(first, closedId);
  await stop();
  const server = await start(START + days * DAY + SLACK, 1000);
  return { server, workspaceId, openId, closedId, file };
}

describe("chat retention", () => {
  it("deletes a chat closed longer ago than retention.days, on disk, in the store, and in memory", async () => {
    setDays(30);
    const { server, openId, closedId, file } = await closedChatThenRestarted(31);

    expect(existsSync(file)).toBe(false);
    expect(count(server, "agents_agents", "id", closedId)).toBe(0);
    expect(await agentStatus(server, closedId)).toBe(404);
    expect(count(server, "agents_deliveries", "agent_id", closedId)).toBe(0);
    expect(count(server, "attention_questions", "agent_id", closedId)).toBe(0);
    expect(server.events.eventsOf("agents:list")).toContainEqual({
      type: "removed",
      id: closedId,
    });
    // The open chat of the same workspace is older than the limit too, and stays with its rows.
    expect(await agentStatus(server, openId)).toBe(200);
    expect(count(server, "attention_questions", "agent_id", openId)).toBe(1);
    expect(count(server, "agents_deliveries", "agent_id", openId)).toBe(1);
  });

  it("keeps a chat closed more recently than retention.days", async () => {
    setDays(30);
    const { server, closedId, file } = await closedChatThenRestarted(29);

    expect(existsSync(file)).toBe(true);
    expect(await agentStatus(server, closedId)).toBe(200);
    expect(count(server, "attention_questions", "agent_id", closedId)).toBe(1);
  });

  it("deletes nothing when retention.days is 0", async () => {
    setDays(0);
    const { server, closedId, file } = await closedChatThenRestarted(400);

    expect(existsSync(file)).toBe(true);
    expect(await agentStatus(server, closedId)).toBe(200);
  });

  it("keeps a closed chat while an open fork of it has not started, and deletes it after", async () => {
    setDays(30);
    const first = await start(START);
    const workspaceId = await makeWorkspace(first, "forks");
    const parent = await newChat(first, workspaceId, "worker");
    const parentFile = giveSession(first, workspaceId, parent);
    const fork = await newChat(first, workspaceId, "side", true);
    await close(first, parent);
    await stop();

    const second = await start(START + 31 * DAY + SLACK, 1000);
    expect(existsSync(parentFile)).toBe(true);
    expect(await agentStatus(second, parent)).toBe(200);

    // The fork's first start has written its session file.
    giveSession(second, workspaceId, fork);
    await stop();
    const third = await start(START + 32 * DAY, 2000);
    expect(existsSync(parentFile)).toBe(false);
    expect(await agentStatus(third, parent)).toBe(404);
    expect(await agentStatus(third, fork)).toBe(200);
  });

  it("deletes the chats, session folder, and questions of an archived workspace past the limit", async () => {
    setDays(30);
    const first = await start(START);
    const workspaceId = await makeWorkspace(first, "gone");
    const worker = await newChat(first, workspaceId, "worker");
    const file = giveSession(first, workspaceId, worker);
    addAttention(first, workspaceId, worker);
    await ok(await first.request("POST", `/api/workspaces/${workspaceId}/archive`, {}));
    await stop();

    const server = await start(START + 31 * DAY + SLACK, 1000);

    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(server.paths.sessions, workspaceId))).toBe(false);
    expect(await agentStatus(server, worker)).toBe(404);
    expect(count(server, "agents_agents", "workspace_id", workspaceId)).toBe(0);
    expect(count(server, "agents_deliveries", "agent_id", worker)).toBe(0);
    expect(count(server, "attention_questions", "workspace_id", workspaceId)).toBe(0);
  });

  it("starts no new chat in an archived workspace, but still answers with its active worker", async () => {
    const server = await start(START);
    const bare = await makeWorkspace(server, "bare");
    const busy = await makeWorkspace(server, "busy");
    const worker = await newChat(server, busy, "worker");
    for (const id of [bare, busy])
      await ok(await server.request("POST", `/api/workspaces/${id}/archive`, {}));

    const refused = await server.request("POST", "/api/agents", { workspaceId: bare });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_archived",
    );
    const side = await server.request("POST", "/api/agents/chats", {
      workspaceId: busy,
      kind: "side",
    });
    expect(side.status).toBe(409);
    expect(((await side.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_active",
    );
    const existing = await ok<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId: busy }),
    );
    expect(existing.agent.id).toBe(worker);
  });
});
