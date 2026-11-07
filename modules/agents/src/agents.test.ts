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
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { unityModule } from "@pi-spore/mod-unity/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import type { Agent, ChatState } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentsModuleOptions } from "./server.js";
import { type AgentEvent, createAgentsModule } from "./server.js";

const FAKE_PI = fileURLToPath(new URL("../test-fixtures/fake-pi.mjs", import.meta.url));

let server: TestServer;
let scratch: string;
let record: string;
let agentsModule: ReturnType<typeof createAgentsModule>;

async function setup(
  options: AgentsModuleOptions = {},
  extraEnv: Record<string, string> = {},
  serverOptions: { home?: string; firstId?: number } = {},
) {
  agentsModule = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({ provider: "fake", modelId: "fake-1", thinking: "high" }),
    baseEnv: {
      PATH: process.env.PATH,
      ORCA_PANE_KEY: "pane",
      HERDR_ENV: "x",
      FAKE_PI_RECORD: record,
      ...extraEnv,
    },
    idleStopMs: 60_000,
    startTimeoutMs: 5_000,
    ...options,
  });
  server = await createTestServer(
    [projectsModule, vcsGitModule, vcsFolderModule, workspacesModule, unityModule, agentsModule],
    serverOptions,
  );
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-agents-")));
  record = join(scratch, "launches.jsonl");
});
afterEach(async () => {
  await agentsModule?.manager().stopAll();
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = (await response.json()) as T;
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** A folder project with one in-place workspace and its worker agent. */
async function makeAgent(name = "notes", files: Record<string, string> = {}) {
  const folder = join(scratch, name);
  mkdirSync(folder, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  const { project } = await json<{ project: { id: string } }>(
    await server.request("POST", "/api/projects", { path: folder }),
    201,
  );
  const { workspace } = await json<{ workspace: { id: string; path: string } }>(
    await server.request("POST", "/api/workspaces", {
      projectId: project.id,
      name: "Chat",
      isolation: "in-place",
    }),
    201,
  );
  const { agent } = await json<{ agent: { id: string } }>(
    await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
    201,
  );
  return { agentId: agent.id, workspaceId: workspace.id, folder };
}

const events = (agentId: string) => server.events.eventsOf(`agent:${agentId}`) as AgentEvent[];
const statuses = (agentId: string) =>
  events(agentId).flatMap((event) => (event.type === "status" ? [event.status] : []));
const status = (agentId: string) => statuses(agentId).at(-1);

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const prompt = (agentId: string, message: string, whileBusy?: string) =>
  server.request("POST", `/api/agents/${agentId}/prompt`, {
    message,
    ...(whileBusy ? { whileBusy } : {}),
  });

async function chat(agentId: string): Promise<ChatState> {
  const [snapshot] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
  if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
  return snapshot.chat;
}

const texts = (state: ChatState) =>
  state.messages.map((message) =>
    typeof message.content === "string"
      ? `${message.role}: ${message.content}`
      : `${message.role}: ${(message.content as { text?: string }[]).map((block) => block.text).join("")}`,
  );

const launches = () =>
  readFileSync(record, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) => JSON.parse(line) as { argv: string[]; env: Record<string, string>; cwd: string },
    );

describe("agents", () => {
  it("starts Pi in the workspace on the first prompt, with a clean env and a new session", async () => {
    await setup();
    const { agentId, workspaceId, folder } = await makeAgent();

    expect(await json(await prompt(agentId, "hello"))).toEqual({ disposition: "started" });
    await until(() => (statuses(agentId).filter((s) => s === "idle").length ?? 0) >= 2);

    const [launch] = launches();
    expect(launch?.cwd).toBe(folder);
    expect(launch?.argv).toEqual([
      "--mode",
      "rpc",
      "--no-extensions",
      "--session-dir",
      join(server.paths.sessions, workspaceId),
      "--provider",
      "fake",
      "--model",
      "fake-1",
      "--thinking",
      "high",
    ]);
    expect(launch?.env).toEqual({
      PI_SPORE_AGENT_ID: agentId,
      PI_SPORE_WORKSPACE_ID: workspaceId,
      PI_SPORE_CHAT_KIND: "worker",
      PI_SPORE_URL: server.url,
      PI_SPORE_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(statuses(agentId)).toEqual(["starting", "idle", "busy", "idle"]);
    // The process's bridge token works until the process ends.
    const token = launch?.env.PI_SPORE_TOKEN;
    expect(server.agentTokens.find(token)).toEqual({ agentId, workspaceId });
    await json(await server.request("POST", `/api/agents/${agentId}/stop`));
    expect(server.agentTokens.find(token)).toBeUndefined();
    expect(texts(await chat(agentId))).toEqual(["user: hello", "assistant: echo: hello"]);
    const row = server.store.get<{ session_file: string }>(
      "SELECT session_file FROM agents_agents WHERE id = ?",
      agentId,
    );
    expect(row?.session_file.startsWith(join(server.paths.sessions, workspaceId))).toBe(true);
  });

  it("streams live Pi events to subscribers", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "hi"));
    await until(() => statuses(agentId).at(-1) === "idle" && statuses(agentId).length >= 4);
    const piTypes = events(agentId).flatMap((event) =>
      event.type === "pi" ? [(event.event as { type: string }).type] : [],
    );
    expect(piTypes).toEqual(
      expect.arrayContaining([
        "agent_start",
        "message_start",
        "message_update",
        "message_end",
        "agent_settled",
      ]),
    );
    expect(events(agentId).some((event) => event.type === "stats")).toBe(true);
  });

  it("resumes the same session after a stop, without forcing the role model", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "one"));
    await until(() => statuses(agentId).length >= 4);
    await json(await server.request("POST", `/api/agents/${agentId}/stop`));
    expect(status(agentId)).toBe("stopped");

    // A stopped agent's snapshot still shows its history, read from the session file.
    expect(texts(await chat(agentId))).toEqual(["user: one", "assistant: echo: one"]);

    await json(await prompt(agentId, "two"));
    await until(() => statuses(agentId).filter((s) => s === "idle").length >= 4);
    const second = launches()[1];
    expect(second?.argv).toContain("--session");
    expect(second?.argv).not.toContain("--model");
    expect(texts(await chat(agentId))).toEqual([
      "user: one",
      "assistant: echo: one",
      "user: two",
      "assistant: echo: two",
    ]);
  });

  it("passes extension dialogs to the page and the answer back to Pi", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "/dialog"));
    await until(() => events(agentId).some((event) => event.type === "dialog"));
    const dialogEvent = events(agentId).find((event) => event.type === "dialog");
    expect(dialogEvent).toMatchObject({
      dialog: { id: "dlg-1", method: "confirm", title: "Proceed?" },
    });

    await json(
      await server.request("POST", `/api/agents/${agentId}/dialog`, {
        dialogId: "dlg-1",
        confirmed: true,
      }),
    );
    await until(() => statuses(agentId).filter((s) => s === "idle").length >= 2);
    expect(texts(await chat(agentId)).at(-1)).toBe("assistant: confirmed: true");
    expect(events(agentId).some((event) => event.type === "dialog_closed")).toBe(true);

    const again = await server.request("POST", `/api/agents/${agentId}/dialog`, {
      dialogId: "dlg-1",
      confirmed: true,
    });
    expect(again.status).toBe(409);
  });

  it("queues a message sent while the agent works, and aborts a run", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "slow:400"));
    await until(() => status(agentId) === "busy");

    expect(await json(await prompt(agentId, "also this"))).toEqual({ disposition: "queued" });
    await json(await server.request("POST", `/api/agents/${agentId}/abort`));
    await until(() => status(agentId) === "idle" && statuses(agentId).length >= 4);
    const settled = events(agentId).flatMap((event) =>
      event.type === "pi" && (event.event as { type: string }).type === "agent_settled"
        ? [event.event]
        : [],
    );
    expect(settled.at(-1)).toMatchObject({ aborted: true });
  });

  it("reports a crash with Pi's stderr and starts again on the next prompt", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await prompt(agentId, "crash");
    await until(() => status(agentId) === "failed");
    const failure = events(agentId)
      .filter((event) => event.type === "status")
      .at(-1);
    expect(failure).toMatchObject({ status: "failed" });
    expect((failure as { error: string }).error).toContain("boom: the fake agent crashed");

    await json(await prompt(agentId, "again"));
    // Idle after the first start, idle again after the restart, and a third time after the reply.
    await until(
      () => status(agentId) === "idle" && statuses(agentId).filter((s) => s === "idle").length >= 3,
    );
    expect(texts(await chat(agentId)).at(-1)).toBe("assistant: echo: again");
  });

  it("fails a start that does not answer in time instead of hanging", async () => {
    await setup({ startTimeoutMs: 300 }, { FAKE_PI_HANG: "1" });
    const { agentId } = await makeAgent();
    const response = await prompt(agentId, "hello");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "agent_start_failed",
    );
    expect(status(agentId)).toBe("failed");
    expect(agentsModule.manager().liveCount()).toBe(0);
  });

  it("refuses to resume a session whose folder is gone, without starting Pi", async () => {
    await setup();
    const { agentId, folder } = await makeAgent();
    await json(await prompt(agentId, "one"));
    await until(() => statuses(agentId).length >= 4);
    await json(await server.request("POST", `/api/agents/${agentId}/stop`));
    rmSync(folder, { recursive: true, force: true });

    const response = await prompt(agentId, "two");

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "session_folder_missing",
    );
    expect(launches()).toHaveLength(1);
    // The history stays readable.
    expect(texts(await chat(agentId))).toEqual(["user: one", "assistant: echo: one"]);
  });

  it("keeps at most maxLive agents running; others wait until one stops", async () => {
    await setup({ maxLive: 1, idleStopMs: 300 });
    const first = await makeAgent("a");
    const second = await makeAgent("b");
    await json(await prompt(first.agentId, "one"));
    await until(() => status(first.agentId) === "idle" && statuses(first.agentId).length >= 4);

    const pending = prompt(second.agentId, "two");
    await until(() => status(second.agentId) === "waiting");

    // The first agent stops after 300 ms idle, which frees the slot.
    expect(await json(await pending)).toEqual({ disposition: "started" });
    expect(statuses(first.agentId).at(-1)).toBe("stopped");
    await until(
      () =>
        status(second.agentId) === "idle" &&
        statuses(second.agentId).filter((s) => s === "idle").length >= 2,
    );
  });

  it("stops an agent when its workspace is parked, and will not start it while parked", async () => {
    await setup();
    const { agentId, workspaceId } = await makeAgent();
    await json(await prompt(agentId, "hello"));
    await until(() => statuses(agentId).length >= 4);

    await json(await server.request("POST", `/api/workspaces/${workspaceId}/park`));
    expect(status(agentId)).toBe("stopped");
    const refused = await prompt(agentId, "again");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "workspace_not_active",
    );
  });

  it("tells agents in Unity projects which editor is theirs", async () => {
    await setup();
    const { folder } = await makeAgent("game", {
      "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.10f1\n",
    });
    const agentId = (
      (await json<{ agents: { id: string }[] }>(await server.request("GET", "/api/agents")))
        .agents[0] as { id: string }
    ).id;
    await json(await prompt(agentId, "hi"));
    expect(launches()[0]?.env.PI_SPORE_UNITY_PROJECT).toBe(folder);
  });

  it("lists models, thinking levels, and commands, and switches model and thinking", async () => {
    await setup();
    const { agentId } = await makeAgent();
    const models = await json<{ models: { id: string }[]; thinkingLevels: string[] }>(
      await server.request("GET", `/api/agents/${agentId}/models`),
    );
    expect(models.models.map((model) => model.id)).toEqual(["fake-1", "fake-2"]);
    expect(models.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
    const commands = await json<{ commands: { name: string }[] }>(
      await server.request("GET", `/api/agents/${agentId}/commands`),
    );
    expect(commands.commands.map((command) => command.name)).toEqual(["review"]);

    await json(
      await server.request("POST", `/api/agents/${agentId}/model`, {
        provider: "fake",
        modelId: "fake-2",
      }),
    );
    await json(await server.request("POST", `/api/agents/${agentId}/thinking`, { level: "high" }));
    const lastModel = events(agentId)
      .filter((event) => event.type === "model")
      .at(-1);
    expect(lastModel).toMatchObject({
      model: { provider: "fake", id: "fake-2" },
      thinkingLevel: "high",
    });
  });

  it("shows the role model before the first start, and keeps the selected model after a stop", async () => {
    await setup();
    const { agentId } = await makeAgent();
    const [fresh] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
    expect(fresh).toMatchObject({
      model: { provider: "fake", id: "fake-1" },
      thinkingLevel: "high",
    });
    // Showing it did not start Pi: the fake records every launch.
    expect(existsSync(record)).toBe(false);

    await json(
      await server.request("POST", `/api/agents/${agentId}/model`, {
        provider: "fake",
        modelId: "fake-2",
      }),
    );
    await json(await server.request("POST", `/api/agents/${agentId}/thinking`, { level: "low" }));
    await json(await server.request("POST", `/api/agents/${agentId}/stop`));
    const [stopped] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
    expect(stopped).toMatchObject({
      model: { provider: "fake", id: "fake-2" },
      thinkingLevel: "low",
    });
  });

  it("gives each workspace one worker", async () => {
    await setup();
    const { agentId, workspaceId } = await makeAgent();
    const again = await json<{ agent: { id: string } }>(
      await server.request("POST", "/api/agents", { workspaceId }),
    );
    expect(again.agent.id).toBe(agentId);
  });
});

describe("chats (ADR 0030)", () => {
  const view = async (agentId: string) =>
    (await json<{ agent: Agent }>(await server.request("GET", `/api/agents/${agentId}`))).agent;
  const chats = async (workspaceId: string) =>
    (
      await json<{ agents: Agent[] }>(
        await server.request("GET", `/api/agents?workspaceId=${workspaceId}`),
      )
    ).agents;
  const newChat = (workspaceId: string, kind: "worker" | "side", fork?: boolean) =>
    server.request("POST", "/api/agents/chats", {
      workspaceId,
      kind,
      ...(fork === undefined ? {} : { fork }),
    });
  const code = async (response: Response, status: number) => {
    const body = (await response.json()) as { error?: { code: string } };
    expect(response.status).toBe(status);
    return body.error?.code;
  };
  const replied = (agentId: string, count: number) =>
    until(() => statuses(agentId).filter((s) => s === "idle").length >= count);
  const sessionFile = (agentId: string) =>
    server.store.get<{ session_file: string | null }>(
      "SELECT session_file FROM agents_agents WHERE id = ?",
      agentId,
    )?.session_file;

  it("starts a fresh worker chat; the old one stops, stays readable, and cannot run", async () => {
    await setup();
    const { agentId: first, workspaceId } = await makeAgent();
    await json(await prompt(first, "one"));
    await replied(first, 2);

    const { agent: second } = await json<{ agent: Agent }>(
      await newChat(workspaceId, "worker"),
      201,
    );
    expect(second).toMatchObject({ kind: "worker", active: true, status: "stopped" });
    expect(await view(first)).toMatchObject({ active: false, status: "stopped", title: "one" });
    expect(texts(await chat(first))).toEqual(["user: one", "assistant: echo: one"]);
    expect(await code(await prompt(first, "two"), 409)).toBe("chat_inactive");

    // The page's "get the worker" call now answers with the new chat.
    const current = await json<{ agent: Agent }>(
      await server.request("POST", "/api/agents", { workspaceId }),
    );
    expect(current.agent.id).toBe(second.id);

    await json(await prompt(second.id, "fresh"));
    await replied(second.id, 2);
    expect(launches()[1]?.argv).toContain("--session-dir");
    expect(texts(await chat(second.id))).toEqual(["user: fresh", "assistant: echo: fresh"]);
    expect((await chats(workspaceId)).map((agent) => agent.id)).toEqual([second.id, first]);
  });

  it("does not switch chats while the worker is working", async () => {
    await setup();
    const { agentId, workspaceId } = await makeAgent();
    await json(await prompt(agentId, "slow:400"));
    await until(() => status(agentId) === "busy");
    expect(await code(await newChat(workspaceId, "worker"), 409)).toBe("worker_busy");
    expect((await view(agentId)).active).toBe(true);
  });

  it("makes an older worker chat active again and stops the current one first", async () => {
    await setup();
    const { agentId: first, workspaceId } = await makeAgent();
    await json(await prompt(first, "one"));
    await replied(first, 2);
    const { agent: second } = await json<{ agent: Agent }>(
      await newChat(workspaceId, "worker"),
      201,
    );
    await json(await prompt(second.id, "two"));
    await replied(second.id, 2);

    const { agent } = await json<{ agent: Agent }>(
      await server.request("POST", `/api/agents/${first}/activate`),
    );
    expect(agent).toMatchObject({ id: first, active: true });
    expect(await view(second.id)).toMatchObject({ active: false, status: "stopped" });
    expect(agentsModule.manager().liveCount()).toBe(0);

    await json(await prompt(first, "three"));
    await replied(first, 4);
    expect(launches().at(-1)?.argv).toEqual(
      expect.arrayContaining(["--session", sessionFile(first)]),
    );
    expect(texts(await chat(first)).slice(-2)).toEqual(["user: three", "assistant: echo: three"]);
    expect((await chats(workspaceId)).map((chat) => chat.id)).toEqual([first, second.id]);
  });

  it("gives a side chat a copy of the worker's context and read-only tools", async () => {
    await setup();
    const { agentId: worker, workspaceId } = await makeAgent();
    await json(await prompt(worker, "one"));
    await replied(worker, 2);

    const { agent: side } = await json<{ agent: Agent }>(
      await newChat(workspaceId, "side", true),
      201,
    );
    expect(side).toMatchObject({ kind: "side", active: true, forkedFrom: worker });
    await json(await prompt(side.id, "tools"));
    await replied(side.id, 2);

    const launch = launches()[1];
    const tools = ["--tools", "read,grep,find,ls,request_human_input", "--exclude-tools", "mcp__*"];
    expect(launch?.argv).toEqual([
      "--mode",
      "rpc",
      "--no-extensions",
      "--fork",
      sessionFile(worker),
      "--session-dir",
      join(server.paths.sessions, workspaceId),
      ...tools,
    ]);
    expect(launch?.env.PI_SPORE_CHAT_KIND).toBe("side");
    // Its bridge token is marked read-only, so bridge routes that run commands refuse it.
    expect(server.agentTokens.find(launch?.env.PI_SPORE_TOKEN)).toEqual({
      agentId: side.id,
      workspaceId,
      readOnly: true,
    });
    expect(texts(await chat(side.id))).toEqual([
      "user: one",
      "assistant: echo: one",
      "user: tools",
      "assistant: tools: read,grep,find,ls,request_human_input",
    ]);
    // The worker and the side chat run at the same time, and the side chat has its own session file.
    expect(agentsModule.manager().liveCount()).toBe(2);
    expect(sessionFile(side.id)).not.toBe(sessionFile(worker));
    // Its own first message names it, not the worker's.
    expect((await view(side.id)).title).toBe("tools");

    await json(await server.request("POST", `/api/agents/${side.id}/stop`));
    await json(await prompt(side.id, "again"));
    await replied(side.id, 4);
    expect(launches()[2]?.argv).toEqual(
      expect.arrayContaining(["--session", sessionFile(side.id), ...tools]),
    );
    expect(launches()[2]?.argv).not.toContain("--fork");
  });

  it("starts an empty side chat with read-only tools, and refuses a fork with nothing to copy", async () => {
    await setup();
    const { workspaceId } = await makeAgent();
    expect(await code(await newChat(workspaceId, "side", true), 409)).toBe("nothing_to_fork");
    expect(await code(await newChat(workspaceId, "worker", true), 400)).toBe("bad_request");

    const { agent: side } = await json<{ agent: Agent }>(await newChat(workspaceId, "side"), 201);
    await json(await prompt(side.id, "tools"));
    await replied(side.id, 2);
    expect(launches()[0]?.argv).toEqual(
      expect.arrayContaining(["--session-dir", "--tools", "--exclude-tools"]),
    );
    expect(texts(await chat(side.id)).at(-1)).toBe(
      "assistant: tools: read,grep,find,ls,request_human_input",
    );
    // A side chat is never a worker chat to switch to.
    expect(await code(await server.request("POST", `/api/agents/${side.id}/activate`), 409)).toBe(
      "not_a_worker_chat",
    );
  });

  it("counts side chats against the live-agent limit", async () => {
    await setup({ maxLive: 1 });
    const { agentId: worker, workspaceId } = await makeAgent();
    await json(await prompt(worker, "one"));
    await replied(worker, 2);
    const { agent: side } = await json<{ agent: Agent }>(await newChat(workspaceId, "side"), 201);

    const pending = prompt(side.id, "hi");
    await until(() => status(side.id) === "waiting");
    await json(await server.request("POST", `/api/agents/${worker}/stop`));
    expect(await json(await pending)).toEqual({ disposition: "started" });
  });

  it("titles a chat with its first message, cut short, and lets the user rename it", async () => {
    await setup();
    const { agentId } = await makeAgent();
    expect((await view(agentId)).title).toBeUndefined();
    await json(await prompt(agentId, `\n  Fix   the ${"login ".repeat(20)}\nsecond line`));
    const title = (await view(agentId)).title ?? "";
    expect(title.startsWith("Fix the login login")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);

    const renamed = await json<{ agent: Agent }>(
      await server.request("POST", `/api/agents/${agentId}/title`, { title: "  Login  page " }),
    );
    expect(renamed.agent.title).toBe("Login page");
    await json(await prompt(agentId, "later"));
    expect((await view(agentId)).title).toBe("Login page");
    expect(
      await code(
        await server.request("POST", `/api/agents/${agentId}/title`, { title: "  " }),
        400,
      ),
    ).toBe("bad_request");
  });

  it("keeps a workspace's existing worker as its active worker chat after the upgrade", async () => {
    const home = join(scratch, "home");
    await setup({}, {}, { home });
    const { agentId, workspaceId } = await makeAgent();
    await json(await prompt(agentId, "before"));
    await replied(agentId, 2);
    await agentsModule.manager().stopAll();
    server.close();

    // Put the store back to the one-worker table of migration 3.
    const db = new DatabaseSync(server.paths.database);
    db.exec(`
      CREATE TABLE old AS SELECT id, workspace_id, role, session_file, created_at, waiting_since FROM agents_agents;
      DROP TABLE agents_agents;
      CREATE TABLE agents_agents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, role TEXT NOT NULL, session_file TEXT,
        created_at INTEGER NOT NULL, waiting_since INTEGER, UNIQUE (workspace_id, role)
      );
      INSERT INTO agents_agents SELECT * FROM old;
      DROP TABLE old;
      DELETE FROM core_migrations WHERE module = 'agents' AND version = 4;
    `);
    db.close();

    await setup({}, {}, { home, firstId: 1_000 });
    const { agent } = await json<{ agent: Agent }>(
      await server.request("POST", "/api/agents", { workspaceId }),
    );
    expect(agent).toMatchObject({ id: agentId, kind: "worker", active: true });
    expect(texts(await chat(agentId))).toEqual(["user: before", "assistant: echo: before"]);
    // The title comes from the history once the chat is read.
    expect((await view(agentId)).title).toBe("before");
    // A second worker chat is now possible.
    await json(await newChat(workspaceId, "worker"), 201);
  });
});

describe("pi-subagents helpers as child runs (R3.3, ADR 0034)", () => {
  const helper = (agentId: string, id: string, state: string, agent = "scout") =>
    prompt(agentId, `helper:${id}:${agent}:${state}`);
  const childEvents = (agentId: string) =>
    events(agentId).flatMap((event) => (event.type === "children" ? [event.children] : []));
  const latest = (agentId: string) => childEvents(agentId).at(-1);
  const snapshotChildren = async (agentId: string) => {
    const [snapshot] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
    if (snapshot?.type !== "snapshot") throw new Error("No snapshot");
    return snapshot.children;
  };

  it("lists a helper under its worker with agent, model, and state, and drops it when it is cleared", async () => {
    await setup();
    const { agentId } = await makeAgent();

    await json(await helper(agentId, "run-1", "running"));
    await until(() => latest(agentId)?.length === 1);
    expect(latest(agentId)).toEqual([
      {
        id: "run-1",
        label: "scout",
        state: "running",
        startedAt: 1000,
        steps: [
          {
            id: "step:0",
            label: "scout",
            state: "running",
            agent: "scout",
            model: "fake/helper-model",
            thinking: "low",
          },
        ],
      },
    ]);
    // A page that opens now gets it in its snapshot.
    expect((await snapshotChildren(agentId)).map((run) => run.id)).toEqual(["run-1"]);

    await json(await helper(agentId, "run-1", "complete"));
    await until(() => latest(agentId)?.[0]?.state === "complete");
    await json(await prompt(agentId, "helper-clear"));
    await until(() => latest(agentId)?.length === 0);
    expect(await snapshotChildren(agentId)).toEqual([]);
  });

  it("publishes only when what a page shows changes, although the widget repeats", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await helper(agentId, "run-1", "running"));
    await json(await helper(agentId, "run-1", "running"));
    await json(await helper(agentId, "run-2", "queued", "worker"));
    await until(() => latest(agentId)?.length === 2);
    expect(childEvents(agentId).map((runs) => runs.map((run) => run.id))).toEqual([
      ["run-1"],
      ["run-1", "run-2"],
    ]);
  });

  it("empties the list when the agent's process exits, since nothing reports the helpers then", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await helper(agentId, "run-1", "running"));
    await until(() => latest(agentId)?.length === 1);

    await json(await server.request("POST", `/api/agents/${agentId}/stop`));
    await until(() => latest(agentId)?.length === 0);
    expect(await snapshotChildren(agentId)).toEqual([]);
  });

  it("shows one notice for a payload it does not understand, and keeps the list", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await helper(agentId, "run-1", "running"));
    await until(() => latest(agentId)?.length === 1);

    await json(await prompt(agentId, "helper-bad"));
    await json(await prompt(agentId, "helper-bad"));
    await json(await helper(agentId, "run-1", "complete"));
    await until(() => latest(agentId)?.[0]?.state === "complete");

    const notices = events(agentId).flatMap((event) =>
      event.type === "notice" ? [event.message] : [],
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Helper runs are not shown: .*version/);
  });

  it("counts running helpers against maxLive: a new agent waits until they end", async () => {
    await setup({ maxLive: 2 });
    const first = await makeAgent("a");
    const second = await makeAgent("b");
    await json(await helper(first.agentId, "run-1", "running"));
    await until(() => latest(first.agentId)?.length === 1);
    expect(agentsModule.manager().runningChildren()).toBe(1);

    // One agent and one running helper fill both slots.
    const pending = prompt(second.agentId, "hello");
    await until(() => status(second.agentId) === "waiting");
    // A queued helper holds no process.
    await json(await helper(first.agentId, "run-2", "queued", "worker"));
    expect(agentsModule.manager().runningChildren()).toBe(1);

    await json(await helper(first.agentId, "run-1", "complete"));
    expect(await json(await pending)).toEqual({ disposition: "started" });
    expect(agentsModule.manager().runningChildren()).toBe(0);
  });

  it("does not stop an idle agent while a helper runs, and stops it after", async () => {
    await setup({ idleStopMs: 100 });
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "hello"));
    await until(() => statuses(agentId).filter((s) => s === "idle").length >= 2);
    await json(await helper(agentId, "run-1", "running"));
    await until(() => latest(agentId)?.length === 1);

    // Several idle periods pass. Only a real wait can show that nothing happens.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(status(agentId)).toBe("idle");

    await json(await helper(agentId, "run-1", "complete"));
    await until(() => status(agentId) === "stopped");
  });

  it("reads a helper's transcript from the agent's process", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await helper(agentId, "run-1", "running"));
    await until(() => latest(agentId)?.length === 1);

    const { transcript } = await json<{ transcript: unknown }>(
      await server.request("GET", `/api/agents/${agentId}/children/run-1/transcript?child=step:0`),
    );
    expect(transcript).toEqual({
      childId: "step:0",
      status: "running",
      label: "scout",
      task: "task of run-1",
      messages: [{ role: "assistant", kind: "text", text: "scout says hello" }],
      finalOutput: "all done",
      model: "fake/helper-model",
      truncated: false,
    });
  });

  it("refuses a transcript of an unknown run, a bad id, or an agent that is not running", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await helper(agentId, "run-1", "running"));
    await until(() => latest(agentId)?.length === 1);
    const get = async (path: string) => {
      const response = await server.request("GET", `/api/agents/${agentId}/${path}`);
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    };

    expect(await get("children/other/transcript")).toEqual([404, "child_not_found"]);
    // The id goes into a slash command, so a space must not pass.
    expect(await get("children/run-1/transcript?child=a%20--lines%209")).toEqual([
      400,
      "bad_child_id",
    ]);
    await json(await server.request("POST", `/api/agents/${agentId}/stop`));
    expect(await get("children/run-1/transcript")).toEqual([404, "child_not_found"]);
  });
});
