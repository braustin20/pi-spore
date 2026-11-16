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
import { ProjectsKey, projectsModule } from "@pi-spore/mod-projects/server";
import { unityTrait } from "@pi-spore/mod-unity/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";
import { TIERS } from "@pi-spore/router";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { type Agent, type ChatState, MODEL_TIERS, type Workspace } from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_PNG } from "../test-fixtures/png.mjs";
import type { AgentChange, Agents, LaunchHook } from "./contract.js";
import type { AgentsModuleOptions } from "./server.js";
import { type AgentEvent, AgentsKey, createAgentsModule } from "./server.js";
import { reduceAgentList, workspaceStatus } from "./status.js";

const FAKE_PI = fileURLToPath(new URL("../test-fixtures/fake-pi.mjs", import.meta.url));

/** Only the Unity trait: the full unity module also needs the actions, artifacts, and attention modules. */
const unityTraitModule: ServerModule = {
  id: "unity",
  requires: ["projects"],
  core: false,
  setup: (host) => host.use(ProjectsKey).registerTrait(unityTrait),
};

let server: TestServer;
let scratch: string;
let record: string;
let agentsModule: ReturnType<typeof createAgentsModule>;

async function setup(
  options: AgentsModuleOptions = {},
  extraEnv: Record<string, string> = {},
  serverOptions: { home?: string; firstId?: number; startAt?: number } = {},
  extraModules: readonly ServerModule[] = [],
) {
  agentsModule = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    // A test that names an agent folder reads its settings.json instead (ADR 0013).
    ...(options.agentDir
      ? {}
      : { roleDefaults: async () => ({ provider: "fake", modelId: "fake-1", thinking: "high" }) }),
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
    [
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      unityTraitModule,
      agentsModule,
      ...extraModules,
    ],
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

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
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
      (line) =>
        JSON.parse(line) as {
          argv: string[];
          env: Record<string, string>;
          cwd: string;
          pid: number;
        },
    );

describe("agents", () => {
  it("pushes list snapshots and status updates without navigation", async () => {
    await setup();
    const [empty] = await server.events.snapshot("agents:list");
    let list = reduceAgentList([], empty);
    const { agentId, workspaceId } = await makeAgent();
    const workspace = { id: workspaceId, state: "active" } as Workspace;
    expect(workspaceStatus(workspace, undefined).text).toBe("No agent yet");
    for (const event of server.events.eventsOf("agents:list")) list = reduceAgentList(list, event);
    expect(
      workspaceStatus(
        workspace,
        list.find((agent) => agent.id === agentId),
      ).text,
    ).toBe("Agent stopped");
    await json(await prompt(agentId, "first"));
    await until(() => statuses(agentId).length >= 4 && status(agentId) === "idle");
    const [snapshot] = await server.events.snapshot("agents:list");
    list = reduceAgentList([], snapshot);
    expect(
      workspaceStatus(
        workspace,
        list.find((agent) => agent.id === agentId),
      ).text,
    ).toBe("Idle");
    const before = server.events.eventsOf("agents:list").length;
    await json(await prompt(agentId, "hello"));
    await until(() => statuses(agentId).filter((s) => s === "busy").length >= 2);
    const updates = server.events.eventsOf("agents:list").slice(before) as { agent: Agent }[];
    const busy = updates.find(
      (event) => event.agent?.id === agentId && event.agent.status === "busy",
    );
    expect(busy).toBeDefined();
    list = reduceAgentList(list, busy);
    expect(
      workspaceStatus(
        workspace,
        list.find((agent) => agent.id === agentId),
      ).text,
    ).toBe("Working");
  });

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
      PI_SPORE_SERVER_PID: String(process.pid),
      PI_SPORE_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
      // pi-subagents refuses deeper helpers itself (ADR 0168).
      PI_SUBAGENT_MAX_DEPTH: "2",
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
    await setup({ maxLive: 1 });
    const first = await makeAgent("a");
    const second = await makeAgent("b");
    await json(await prompt(first.agentId, "slow:300"));
    await until(() => status(first.agentId) === "busy");

    const pending = prompt(second.agentId, "two");
    await until(() => status(second.agentId) === "waiting");

    // The first agent ends its run and is idle with a chat waiting, so it stops and frees the slot.
    expect(await json(await pending)).toEqual({ disposition: "started" });
    expect(statuses(first.agentId).at(-1)).toBe("stopped");
    await until(
      () =>
        status(second.agentId) === "idle" &&
        statuses(second.agentId).filter((s) => s === "idle").length >= 2,
    );
  });

  describe("limits come from settings.json (R3.6)", () => {
    const home = () => join(scratch, "home");
    const writeSettings = (text: string) => {
      mkdirSync(home(), { recursive: true });
      writeFileSync(join(home(), "settings.json"), text);
    };

    it("reads agents.maxLive at startup", async () => {
      writeSettings('{"agents":{"maxLive":1}}');
      await setup({}, {}, { home: home() });
      const first = await makeAgent("a");
      const second = await makeAgent("b");
      // A busy agent is never stopped for a waiting chat, so only stopping it frees the slot.
      await json(await prompt(first.agentId, "slow:60000"));
      await until(() => status(first.agentId) === "busy");

      const pending = prompt(second.agentId, "two");
      await until(() => status(second.agentId) === "waiting");
      expect(statuses(second.agentId)).not.toContain("busy");

      await json(await server.request("POST", `/api/agents/${first.agentId}/stop`));
      expect(await json(await pending)).toEqual({ disposition: "started" });
    });

    it("passes agents.maxSubagentDepth to Pi as PI_SUBAGENT_MAX_DEPTH (ADR 0168)", async () => {
      writeSettings('{"agents":{"maxSubagentDepth":0}}');
      await setup({}, { PI_SUBAGENT_MAX_DEPTH: "5" }, { home: home() });
      const { agentId } = await makeAgent();
      await json(await prompt(agentId, "hello"));
      await until(() => statuses(agentId).filter((s) => s === "idle").length >= 2);
      // The setting beats the value in the server's own env.
      expect(launches()[0]?.env.PI_SUBAGENT_MAX_DEPTH).toBe("0");
    });

    it("lists the agents keys with their source on the settings route", async () => {
      writeSettings('{"agents":{"maxImagesPerMessage":3}}');
      await setup({}, {}, { home: home() });
      const { settings } = await json<{
        settings: { key: string; value: unknown; source: string }[];
      }>(await server.request("GET", "/api/projects/settings"));
      expect(settings.filter((entry) => entry.key.startsWith("agents."))).toEqual([
        { key: "agents.idleStopMinutes", value: 10, source: "default" },
        { key: "agents.maxImageBytes", value: 10 * 1024 * 1024, source: "default" },
        { key: "agents.maxImagesPerMessage", value: 3, source: "global" },
        { key: "agents.maxLive", value: 8, source: "default" },
        { key: "agents.maxSubagentDepth", value: 2, source: "default" },
      ]);
    });
  });

  describe("a waiting chat takes the slot of an idle one (ADR 0026)", () => {
    const idleAfterPrompt = async (agentId: string, message: string) => {
      await json(await prompt(agentId, message));
      await until(() => status(agentId) === "idle" && statuses(agentId).length >= 4);
    };

    it("stops the agent that has been idle longest, at once", async () => {
      await setup({ maxLive: 2 });
      const first = await makeAgent("a");
      const second = await makeAgent("b");
      const third = await makeAgent("c");
      await idleAfterPrompt(first.agentId, "one");
      await idleAfterPrompt(second.agentId, "two");

      expect(await json(await prompt(third.agentId, "three"))).toEqual({ disposition: "started" });
      expect(status(first.agentId)).toBe("stopped");
      expect(status(second.agentId)).toBe("idle");
    });

    it("never stops a busy agent", async () => {
      await setup({ maxLive: 2 });
      const busy = await makeAgent("a");
      const idle = await makeAgent("b");
      const third = await makeAgent("c");
      await json(await prompt(busy.agentId, "slow:60000"));
      await until(() => status(busy.agentId) === "busy");
      await idleAfterPrompt(idle.agentId, "two");

      expect(await json(await prompt(third.agentId, "three"))).toEqual({ disposition: "started" });
      expect(status(idle.agentId)).toBe("stopped");
      expect(status(busy.agentId)).toBe("busy");
    });

    it("keeps a chat waiting when every live agent is busy", async () => {
      await setup({ maxLive: 2 });
      const first = await makeAgent("a");
      const second = await makeAgent("b");
      const third = await makeAgent("c");
      await json(await prompt(first.agentId, "slow:60000"));
      await json(await prompt(second.agentId, "slow:60000"));
      await until(() => status(first.agentId) === "busy" && status(second.agentId) === "busy");

      const pending = prompt(third.agentId, "three");
      await until(() => status(third.agentId) === "waiting");
      expect(status(first.agentId)).toBe("busy");
      expect(status(second.agentId)).toBe("busy");

      await json(await server.request("POST", `/api/agents/${first.agentId}/stop`));
      expect(await json(await pending)).toEqual({ disposition: "started" });
    });
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

  describe("model list without a chat (ADR 0120)", () => {
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };

    it("starts a short-lived process, stops it, and serves the next call from the cache", async () => {
      await setup();
      const list = () => server.request("GET", "/api/agents/models");
      const first = await json<{ models: { id: string }[] }>(await list());
      expect(first.models.map((model) => model.id)).toEqual(["fake-1", "fake-2"]);
      expect(launches()).toHaveLength(1);
      await until(() => gone(launches()[0]?.pid as number));
      await json(await list());
      expect(launches()).toHaveLength(1);
    });

    it("asks again when the cache time is over", async () => {
      await setup({ modelsCacheMs: 0 });
      await json(await server.request("GET", "/api/agents/models"));
      await json(await server.request("GET", "/api/agents/models"));
      expect(launches()).toHaveLength(2);
    });

    it("names the cause when Pi does not answer, and stops the process", async () => {
      await setup({ startTimeoutMs: 200 }, { FAKE_PI_HANG: "1" });
      const body = await json<{ error: { message: string } }>(
        await server.request("GET", "/api/agents/models"),
        502,
      );
      expect(body.error.message).toContain("did not answer");
      await until(() => gone(launches()[0]?.pid as number));
    });

    it("rejects an answer that is not a model list", async () => {
      await setup({}, { FAKE_PI_MODELS: "broken" });
      const body = await json<{ error: { message: string } }>(
        await server.request("GET", "/api/agents/models"),
        502,
      );
      expect(body.error.message).toContain("model list");
      await until(() => gone(launches()[0]?.pid as number));
    });
  });

  describe("a model list asked for by an agent that holds the last live slot", () => {
    it("asks the caller's own process, so a busy chat with a queued chat behind it gets the list and no process starts", async () => {
      const probe = agentsProbe();
      await setup({ maxLive: 1 }, {}, {}, [probe.module]);
      const caller = await makeAgent("caller");
      const queued = await makeAgent("queued");
      await json(await prompt(caller.agentId, "slow:60000"));
      await until(() => status(caller.agentId) === "busy");
      void prompt(queued.agentId, "next");
      await until(() => status(queued.agentId) === "waiting");

      let models: { id: string }[] | undefined;
      void probe
        .agents()
        .availableModels(caller.agentId)
        .then((found) => {
          models = found;
        });

      await until(() => models !== undefined);
      expect(models?.map((model) => model.id)).toEqual(["fake-1", "fake-2"]);
      expect(launches()).toHaveLength(1);
      expect(status(caller.agentId)).toBe("busy");
      expect(status(queued.agentId)).toBe("waiting");
    });
  });

  describe("model tiers from settings.json", () => {
    type Listed = { models: { id: string; tier?: string }[]; tierError?: string };
    const writeSettings = (text: string) =>
      writeFileSync(join(server.paths.root, "settings.json"), text);
    const tiersOf = (body: Listed) => body.models.map((model) => [model.id, model.tier]);

    it("gives a model in tiers its tier, and leaves the other without one", async () => {
      await setup();
      writeSettings(JSON.stringify({ tiers: { "fake/fake-2": "heavy" } }));
      const body = await json<Listed>(await server.request("GET", "/api/agents/models"));
      expect(tiersOf(body)).toEqual([
        ["fake-1", undefined],
        ["fake-2", "heavy"],
      ]);
      expect(body.models[0]).not.toHaveProperty("tier");
      expect(body).not.toHaveProperty("tierError");
    });

    it("gives a chat's models their tiers", async () => {
      await setup();
      writeSettings(JSON.stringify({ tiers: { "fake/fake-1": "light" } }));
      const { agentId } = await makeAgent();
      const body = await json<Listed>(await server.request("GET", `/api/agents/${agentId}/models`));
      expect(tiersOf(body)).toEqual([
        ["fake-1", "light"],
        ["fake-2", undefined],
      ]);
    });

    it("still lists the models when settings.json is broken, and names the error", async () => {
      await setup();
      writeSettings("{ not json");
      const body = await json<Listed>(await server.request("GET", "/api/agents/models"));
      expect(tiersOf(body)).toEqual([
        ["fake-1", undefined],
        ["fake-2", undefined],
      ]);
      expect(body.tierError).toContain("settings.json");
    });

    it("keeps the shared tier list equal to the router's", async () => {
      await setup();
      expect(MODEL_TIERS).toEqual(TIERS);
    });
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

  describe("the model of a new chat (ADR 0120)", () => {
    it("starts a new worker chat on the model it was created with and the role's thinking", async () => {
      await setup();
      const { workspaceId } = await makeAgent();
      expect(
        (
          await server.request("POST", "/api/agents/chats", {
            workspaceId,
            kind: "worker",
            model: "no-slash",
          })
        ).status,
      ).toBe(400);
      const { agent } = await json<{ agent: { id: string } }>(
        await server.request("POST", "/api/agents/chats", {
          workspaceId,
          kind: "worker",
          model: "fake/picked-1",
        }),
        201,
      );
      const [fresh] = (await server.events.snapshot(`agent:${agent.id}`)) as AgentEvent[];
      expect(fresh).toMatchObject({
        model: { provider: "fake", id: "picked-1" },
        thinkingLevel: "high",
      });
      await json(await prompt(agent.id, "one"));
      await until(() => existsSync(record));
      const argv = launches()[0]?.argv ?? [];
      expect(argv.slice(argv.indexOf("--provider"))).toEqual([
        "--provider",
        "fake",
        "--model",
        "picked-1",
        "--thinking",
        "high",
      ]);
    });
    it("keeps a model and thinking picked before the first message when the process stops", async () => {
      await setup({ idleStopMs: 100 }, { FAKE_PI_LAZY_SESSION: "1" });
      const { agentId } = await makeAgent();
      await json(
        await server.request("POST", `/api/agents/${agentId}/model`, {
          provider: "fake",
          modelId: "picked-1",
        }),
      );
      await json(await server.request("POST", `/api/agents/${agentId}/thinking`, { level: "low" }));
      // The idle stop ends the process before any prompt, so Pi wrote no session file.
      await until(() => status(agentId) === "stopped");

      await json(await prompt(agentId, "one"));
      await until(() => launches().length === 2 && statuses(agentId).at(-1) === "idle");
      const argv = launches()[1]?.argv ?? [];
      expect(argv.slice(argv.indexOf("--provider"))).toEqual([
        "--provider",
        "fake",
        "--model",
        "picked-1",
        "--thinking",
        "low",
      ]);

      // Once the session file exists, a new launch resumes it, and the session keeps its own model.
      await until(() => status(agentId) === "stopped");
      await json(await prompt(agentId, "two"));
      await until(() => launches().length === 3);
      const resumed = launches()[2]?.argv ?? [];
      expect(resumed).toContain("--session");
      for (const flag of ["--provider", "--model", "--thinking"])
        expect(resumed).not.toContain(flag);
    });
  });

  describe("orchestrator role (ADR 0120)", () => {
    const withSettings = (settings: unknown) => {
      const agentDir = join(scratch, "pi-agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
      return agentDir;
    };

    it("starts a new chat on the orchestrator model and thinking, not the worker's", async () => {
      const agentDir = withSettings({
        subagents: {
          agentOverrides: {
            orchestrator: { model: "fake/orchestrator-1", thinking: "xhigh" },
            worker: { model: "spore/auto", thinking: "low" },
          },
        },
      });
      await setup({ agentDir });
      const { agentId } = await makeAgent();
      const [fresh] = (await server.events.snapshot(`agent:${agentId}`)) as AgentEvent[];
      expect(fresh).toMatchObject({
        model: { provider: "fake", id: "orchestrator-1" },
        thinkingLevel: "xhigh",
      });
      await json(await prompt(agentId, "one"));
      await until(() => existsSync(record));
      const argv = launches()[0]?.argv ?? [];
      expect(argv.slice(argv.indexOf("--provider"))).toEqual(
        expect.arrayContaining([
          "--provider",
          "fake",
          "--model",
          "orchestrator-1",
          "--thinking",
          "xhigh",
        ]),
      );
    });

    it("passes no --model when settings have no orchestrator override", async () => {
      const agentDir = withSettings({
        subagents: { agentOverrides: { worker: { model: "spore/auto", thinking: "low" } } },
      });
      await setup({ agentDir });
      const { agentId } = await makeAgent();
      await json(await prompt(agentId, "one"));
      await until(() => existsSync(record));
      const argv = launches()[0]?.argv ?? [];
      for (const flag of ["--provider", "--model", "--thinking"]) expect(argv).not.toContain(flag);
    });
  });

  describe("role models (ADR 0181)", () => {
    type Listed = {
      roles: {
        name: string;
        kind: string;
        model?: string;
        fallback?: string;
        description?: string;
      }[];
    };
    const agentDir = () => join(scratch, "pi-agent");
    const settingsFile = () => join(agentDir(), "settings.json");
    const builtinDir = () => join(scratch, "builtin-agents");
    const put = (role: string, body: unknown) =>
      server.request("PUT", `/api/agents/role-models/${role}`, body);
    const get = () => server.request("GET", "/api/agents/role-models");
    const agentFile = (dir: string, file: string, frontmatter: string) => {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), `---\n${frontmatter}\n---\nBody\n`);
    };
    const start = async (text: string | undefined) => {
      mkdirSync(agentDir(), { recursive: true });
      if (text !== undefined) writeFileSync(settingsFile(), text);
      await setup({ agentDir: agentDir(), builtinAgentsDir: builtinDir() });
    };
    const original = {
      theme: "dark",
      subagents: {
        projectRootResolution: "git-root",
        agentOverrides: {
          orchestrator: { model: "fake/fake-1", thinking: "xhigh" },
          oracle: { model: "fake/fake-2" },
          worker: { thinking: "low" },
        },
        agentOverridesByProvider: { fake: { worker: { model: "fake/fake-2" } } },
      },
    };
    const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

    it("lists the roles, built-in agents, user agents, and names in agentOverrides", async () => {
      agentFile(builtinDir(), "scout.md", "name: scout\ndescription: x");
      agentFile(builtinDir(), "nameless.md", "description: no name");
      agentFile(builtinDir(), "deep/ignored.md", "name: ignored");
      agentFile(agentDir(), "agents/sub/helper.md", "name: helper\ndescription: x");
      agentFile(agentDir(), "agents/pkg.md", 'name: "tool"\npackage: acme');
      agentFile(agentDir(), "agents/flow.chain.md", "name: flow");
      await start(JSON.stringify(original));
      const { roles } = await json<Listed>(await get());
      expect(roles).toEqual([
        {
          name: "orchestrator",
          kind: "role",
          model: "fake/fake-1",
          description: "The chat that plans a workspace's work and checks it.",
        },
        {
          name: "planner",
          kind: "role",
          fallback: "orchestrator",
          description: "The read-only chat that plans a project and adds its cards.",
        },
        {
          name: "coordinator",
          kind: "role",
          fallback: "orchestrator",
          description: "The chat that runs a run: its lanes, questions, and gates.",
        },
        {
          name: "worker",
          kind: "role",
          description: "The agent that writes the code, in a workspace or a pipeline stage.",
        },
        {
          name: "reviewer",
          kind: "role",
          description: "Reviews a pipeline stage's change with a verdict and findings.",
        },
        {
          name: "adversarial-reviewer",
          kind: "role",
          description: "Looks for what a change breaks.",
        },
        { name: "acme.tool", kind: "subagent" },
        { name: "helper", kind: "subagent", description: "x" },
        { name: "oracle", kind: "subagent", model: "fake/fake-2" },
        { name: "scout", kind: "subagent", description: "x" },
      ]);
    });

    it("describes each entry with one line, from a fixed note or the file's frontmatter", async () => {
      agentFile(builtinDir(), "scout.md", "name: scout\ndescription: Fast recon");
      agentFile(builtinDir(), "helper.md", 'name: helper\ndescription: "The package note"');
      agentFile(builtinDir(), "worker.md", "name: worker\ndescription: A built-in worker note");
      agentFile(builtinDir(), "block.md", "name: block\ndescription: >");
      agentFile(builtinDir(), "blank.md", "name: blank\ndescription:");
      agentFile(agentDir(), "agents/helper.md", "name: helper\ndescription: 'Writes short notes'");
      await start(JSON.stringify(original));
      const { roles } = await json<Listed>(await get());
      const note = (name: string) => roles.find((role) => role.name === name)?.description;
      expect(note("scout")).toBe("Fast recon");
      // The user's file wins over the built-in one, and the quotes go.
      expect(note("helper")).toBe("Writes short notes");
      expect(note("block")).toBeUndefined();
      expect(note("blank")).toBeUndefined();
      // A name with only an `agentOverrides` entry has no description.
      expect(note("oracle")).toBeUndefined();
      // A pi-spore role keeps its own note, even with a pi-subagents file of that name (ADR 0181).
      expect(note("worker")).not.toBe("A built-in worker note");
      expect(roles.filter((role) => role.kind === "role" && !role.description)).toEqual([]);
    });

    it("reads only the last file's description, so a user file clears a built-in one", async () => {
      agentFile(builtinDir(), "plain.md", "name: plain\ndescription: The package note");
      agentFile(builtinDir(), "blocked.md", "name: blocked\ndescription: The package note");
      agentFile(builtinDir(), "blank.md", "name: blank\ndescription: The package note");
      agentFile(agentDir(), "agents/plain.md", "name: plain");
      agentFile(agentDir(), "agents/blocked.md", "name: blocked\ndescription: >-");
      agentFile(agentDir(), "agents/blank.md", "name: blank\ndescription:");
      await start(JSON.stringify(original));
      const { roles } = await json<Listed>(await get());
      const note = (name: string) => roles.find((role) => role.name === name)?.description;
      // No description of its own, a block, and an empty value all give none, not the built-in file's note.
      expect(note("plain")).toBeUndefined();
      expect(note("blocked")).toBeUndefined();
      expect(note("blank")).toBeUndefined();
    });

    it("keeps a quoted description that starts with a block indicator", async () => {
      agentFile(builtinDir(), "arrow.md", 'name: arrow\ndescription: "> Summarizes changes"');
      agentFile(agentDir(), "agents/bar.md", "name: bar\ndescription: '| Marks a note'");
      await start(JSON.stringify(original));
      const { roles } = await json<Listed>(await get());
      const note = (name: string) => roles.find((role) => role.name === name)?.description;
      expect(note("arrow")).toBe("> Summarizes changes");
      expect(note("bar")).toBe("| Marks a note");
    });

    it("describes an agent named like an Object property, not that property", async () => {
      agentFile(builtinDir(), "__proto__.md", "name: __proto__\ndescription: Reads the chain");
      agentFile(builtinDir(), "toString.md", "name: toString\ndescription: Prints the object");
      await start(JSON.stringify(original));
      const { roles } = await json<Listed>(await get());
      const note = (name: string) => roles.find((role) => role.name === name)?.description;
      expect(note("__proto__")).toBe("Reads the chain");
      expect(note("toString")).toBe("Prints the object");
    });

    it("lists the roles when the settings file does not exist", async () => {
      await start(undefined);
      const { roles } = await json<Listed>(await get());
      expect(roles.map((role) => role.name)).toEqual([
        "orchestrator",
        "planner",
        "coordinator",
        "worker",
        "reviewer",
        "adversarial-reviewer",
      ]);
    });

    it("sets only that role's model and leaves every other key", async () => {
      await start(JSON.stringify(original));
      const body = await json<Listed>(await put("oracle", { model: "fake/fake-1" }));
      const expected = structuredClone(original);
      expected.subagents.agentOverrides.oracle.model = "fake/fake-1";
      expect(readSettings()).toEqual(expected);
      expect(readFileSync(settingsFile(), "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
      expect(body).toEqual(await json<Listed>(await get()));
      expect(body.roles.find((role) => role.name === "oracle")?.model).toBe("fake/fake-1");
    });

    it("creates the file, subagents, agentOverrides, and the role object when missing", async () => {
      await start(undefined);
      await json(await put("planner", { model: "fake/fake-2" }));
      expect(readSettings()).toEqual({
        subagents: { agentOverrides: { planner: { model: "fake/fake-2" } } },
      });
      expect(existsSync(`${settingsFile()}.tmp`)).toBe(false);
    });

    it("answers 422 for a model that is not in the model list, and leaves the file bytes", async () => {
      await start(JSON.stringify(original, null, 1));
      const before = readFileSync(settingsFile(), "utf8");
      const body = await json<{ error: { code: string; message: string } }>(
        await put("worker", { model: "fake/nope" }),
        422,
      );
      expect(body.error.code).toBe("unknown_model");
      expect(body.error.message).toContain("fake/nope");
      expect(readFileSync(settingsFile(), "utf8")).toBe(before);
    });

    it("answers 404 for a role that is not in the list", async () => {
      await start(JSON.stringify(original, null, 1));
      const before = readFileSync(settingsFile(), "utf8");
      const body = await json<{ error: { code: string; message: string } }>(
        await put("nobody", { model: "fake/fake-1" }),
        404,
      );
      expect(body.error.code).toBe("unknown_role");
      expect(body.error.message).toContain("nobody");
      expect(readFileSync(settingsFile(), "utf8")).toBe(before);
    });

    it("answers 400 for a body that is neither a model nor an unset", async () => {
      await start(JSON.stringify(original));
      await json(await put("worker", { unset: false }), 400);
      await json(await put("worker", {}), 400);
    });

    it("unsets the model, and removes a role object that is left empty", async () => {
      await start(JSON.stringify(original));
      await json(await put("orchestrator", { unset: true }));
      expect(readSettings().subagents.agentOverrides.orchestrator).toEqual({ thinking: "xhigh" });
      await json(await put("oracle", { unset: true }));
      const settings = readSettings();
      expect(settings.subagents.agentOverrides).not.toHaveProperty("oracle");
      expect(settings.subagents.agentOverrides.worker).toEqual({ thinking: "low" });
      expect(settings.subagents.agentOverridesByProvider).toEqual(
        original.subagents.agentOverridesByProvider,
      );
    });

    it("keeps an empty agentOverrides and subagents, and treats an unset without a model as a no-op", async () => {
      await start(
        JSON.stringify({ subagents: { agentOverrides: { oracle: { model: "fake/fake-1" } } } }),
      );
      await json(await put("oracle", { unset: true }));
      expect(readSettings()).toEqual({ subagents: { agentOverrides: {} } });
      const before = readFileSync(settingsFile(), "utf8");
      await json(await put("planner", { unset: true }));
      await json(await put("worker", { unset: true }));
      expect(readFileSync(settingsFile(), "utf8")).toBe(before);
    });

    it("answers 409 on GET and PUT for a file with a comment, and does not write", async () => {
      const text = '{\n  // my choice\n  "theme": "dark"\n}\n';
      await start(text);
      for (const response of [await get(), await put("worker", { model: "fake/fake-1" })]) {
        const body = await json<{ error: { code: string; message: string } }>(response, 409);
        expect(body.error.code).toBe("pi_settings_not_json");
        expect(body.error.message).toContain(settingsFile());
      }
      expect(readFileSync(settingsFile(), "utf8")).toBe(text);
    });

    it("answers 409 and does not write when subagents is not an object", async () => {
      const text = JSON.stringify({ subagents: "yes" });
      await start(text);
      const body = await json<{ error: { code: string } }>(
        await put("worker", { model: "fake/fake-1" }),
        409,
      );
      expect(body.error.code).toBe("pi_settings_shape");
      expect(readFileSync(settingsFile(), "utf8")).toBe(text);
    });

    it("keeps both changes when two writes run at once", async () => {
      await start(JSON.stringify(original));
      const answers = await Promise.all([
        put("planner", { model: "fake/fake-1" }),
        put("reviewer", { model: "fake/fake-2" }),
        put("coordinator", { model: "fake/fake-2" }),
      ]);
      for (const answer of answers) await json(answer);
      const overrides = readSettings().subagents.agentOverrides;
      expect(overrides.planner.model).toBe("fake/fake-1");
      expect(overrides.reviewer.model).toBe("fake/fake-2");
      expect(overrides.coordinator.model).toBe("fake/fake-2");
    });

    it("answers 409 for a file that is null, and does not write", async () => {
      await start("null\n");
      const bad = [await get(), await put("worker", { model: "fake/fake-1" })];
      for (const response of bad) {
        const body = await json<{ error: { code: string; message: string } }>(response, 409);
        expect(body.error.code).toBe("pi_settings_shape");
        expect(body.error.message).toContain(settingsFile());
      }
      expect(readFileSync(settingsFile(), "utf8")).toBe("null\n");
    });

    it.each([
      ["subagents is a string", { subagents: "yes" }],
      ["subagents is null", { subagents: null }],
      ["agentOverrides is a list", { subagents: { agentOverrides: [] } }],
      ["agentOverrides is null", { subagents: { agentOverrides: null } }],
    ])("answers 409 on GET, set, and unset when %s, and does not write", async (_name, content) => {
      const text = JSON.stringify(content);
      await start(text);
      const bad = [
        await get(),
        await put("worker", { model: "fake/fake-1" }),
        await put("worker", { unset: true }),
      ];
      for (const response of bad) {
        const body = await json<{ error: { code: string } }>(response, 409);
        expect(body.error.code).toBe("pi_settings_shape");
      }
      expect(readFileSync(settingsFile(), "utf8")).toBe(text);
    });

    it("answers 400 for a body with both a model and an unset, and does not write", async () => {
      const text = JSON.stringify(original);
      await start(text);
      await json(await put("worker", { model: "fake/fake-1", unset: true }), 400);
      await json(await put("worker", { model: 7, unset: true }), 400);
      await json(await put("worker", { model: "fake/fake-1", extra: 1 }), 400);
      expect(readFileSync(settingsFile(), "utf8")).toBe(text);
    });

    it("does not list an agent file whose frontmatter has no closing delimiter", async () => {
      mkdirSync(join(agentDir(), "agents"), { recursive: true });
      writeFileSync(join(agentDir(), "agents/open.md"), "---\nname: open\nBody text\n");
      agentFile(agentDir(), "agents/closed.md", "name: closed");
      await start(JSON.stringify(original));
      const { roles } = await json<Listed>(await get());
      const names = roles.map((role) => role.name);
      expect(names).toContain("closed");
      expect(names).not.toContain("open");
    });

    it("starts a chat created after a PUT on the new orchestrator model", async () => {
      await start(JSON.stringify(original));
      await json(await put("orchestrator", { model: "fake/fake-2" }));
      const { agentId } = await makeAgent();
      await json(await prompt(agentId, "one"));
      // The first launch lists the models for the PUT; the chat's is the second.
      await until(() => existsSync(record) && launches().length === 2);
      const argv = launches()[1]?.argv ?? [];
      expect(argv.slice(argv.indexOf("--provider"), argv.indexOf("--provider") + 4)).toEqual([
        "--provider",
        "fake",
        "--model",
        "fake-2",
      ]);
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

/** A module that hands the tests the `Agents` interface other modules get. */
function agentsProbe() {
  let agents: Agents | undefined;
  const module: ServerModule = {
    id: "agents-probe",
    requires: ["agents"],
    core: false,
    setup(host) {
      agents = host.use(AgentsKey);
    },
  };
  return {
    module,
    agents: () => {
      if (!agents) throw new Error("The probe module is not set up");
      return agents;
    },
  };
}

describe("each agent's last activity (R15)", () => {
  const activity = async (agentId: string) =>
    agentsModule
      .manager()
      .attention()
      .find((entry) => entry.agent.id === agentId)?.activity;
  /** The steps Home counts: a tool that starts, and a message that is finished. */
  const steps = (agentId: string) =>
    events(agentId).flatMap((event) =>
      event.type === "pi" &&
      ["message_end", "tool_execution_start"].includes(
        (event.event as { type?: string }).type ?? "",
      )
        ? [1]
        : [],
    ).length;

  it("says nothing before the agent has run", async () => {
    await setup();
    const { agentId } = await makeAgent();
    const entry = agentsModule
      .manager()
      .attention()
      .find((entry) => entry.agent.id === agentId);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("activity");
  });

  it("names the running tool, then the reply, and calls onChange for each step", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    const changes: [string, AgentChange][] = [];
    probe.agents().onChange((id, change) => changes.push([id, change]));

    await json(await prompt(agentId, "bash:npm test"));
    await until(async () => (await activity(agentId)) === "Running bash: npm test");
    expect(changes.filter(([, change]) => change === "activity").length).toBeGreaterThan(0);

    await json(await prompt(agentId, "bash-done"));
    await until(() => status(agentId) === "idle");
    expect(await activity(agentId)).toBe("Replied: echo: bash:npm test");
    // One change per step: a tool that starts or a message that ends, none for a streamed token.
    expect(changes.filter(([id, change]) => id === agentId && change === "activity")).toHaveLength(
      steps(agentId),
    );
  });

  it("keeps the time the agent went busy for the whole run, so the chat counts from it", async () => {
    await setup();
    const { agentId } = await makeAgent();
    const since = () => agentsModule.manager().view(agentId).statusSince;
    const idleSince = since();
    await json(await prompt(agentId, "bash:npm test"));
    await until(async () => (await activity(agentId)) === "Running bash: npm test");
    const busySince = since();
    expect(busySince).toBeGreaterThan(idleSince);
    const busyEvent = events(agentId).find((e) => e.type === "status" && e.status === "busy");
    expect(busyEvent).toMatchObject({ since: busySince });

    // A retry or compaction starts the run again before it settles. It is still the same work.
    await json(await prompt(agentId, "agent-start-again"));
    await until(() => statuses(agentId).filter((s) => s === "busy").length >= 2);
    expect(since()).toBe(busySince);
    expect(
      events(agentId)
        .filter((e) => e.type === "status")
        .at(-1),
    ).toMatchObject({
      since: busySince,
    });

    await json(await prompt(agentId, "bash-done"));
    await until(() => status(agentId) === "idle");
    expect(since()).toBeGreaterThan(busySince);
  });

  it("says the agent asked a question while its dialog is open", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "/dialog"));
    await until(() => events(agentId).some((event) => event.type === "dialog"));
    expect(await activity(agentId)).toBe("Asked a question");

    await json(
      await server.request("POST", `/api/agents/${agentId}/dialog`, {
        dialogId: "dlg-1",
        confirmed: true,
      }),
    );
    await until(() => status(agentId) === "idle");
    expect(await activity(agentId)).toBe("Replied: confirmed: true");
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

  it("tells afterWorkerChange listeners about a new worker chat and an activated one", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId: first, workspaceId } = await makeAgent();
    const changed: Agent[] = [];
    probe.agents().afterWorkerChange((agent) => changed.push(agent));

    const { agent: second } = await json<{ agent: Agent }>(
      await newChat(workspaceId, "worker"),
      201,
    );
    expect(changed).toEqual([second]);

    await json(await newChat(workspaceId, "side"), 201);
    expect(changed).toHaveLength(1);

    await json(await server.request("POST", `/api/agents/${first}/activate`));
    expect(changed.map((agent) => agent.id)).toEqual([second.id, first]);
    expect(changed[1]).toMatchObject({ id: first, active: true });
  });

  it("tells afterWorkerChange listeners about a worker chat that activeWorker creates", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const changed: Agent[] = [];
    probe.agents().afterWorkerChange((agent) => changed.push(agent));
    const { agentId, workspaceId } = await makeAgent();

    expect(changed.map((agent) => agent.id)).toEqual([agentId]);
    await probe.agents().activeWorker(workspaceId);
    expect(changed).toHaveLength(1);
  });

  it("keeps a chat change when an afterWorkerChange listener throws", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    probe.agents().afterWorkerChange(() => {
      throw new Error("listener broke");
    });
    const { agentId, workspaceId } = await makeAgent();

    const { agent } = await json<{ agent: Agent }>(await newChat(workspaceId, "worker"), 201);
    expect(agent.active).toBe(true);
    expect(await view(agentId)).toMatchObject({ active: false });
  });

  it("lists every chat of a workspace, closed ones too, oldest first", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId: first, workspaceId } = await makeAgent();
    const { agent: second } = await json<{ agent: Agent }>(
      await newChat(workspaceId, "worker"),
      201,
    );
    await json(await server.request("POST", `/api/agents/${first}/close`));
    await makeAgent("other");

    expect(
      probe
        .agents()
        .inWorkspace(workspaceId)
        .map((agent) => agent.id),
    ).toEqual([first, second.id]);
  });

  it("stops an agent's process through the interface and rejects an unknown id", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "one"));
    await replied(agentId, 2);
    expect(agentsModule.manager().liveCount()).toBe(1);

    await probe.agents().stop(agentId);
    expect(await view(agentId)).toMatchObject({ status: "stopped" });
    await expect(probe.agents().stop("missing")).rejects.toMatchObject({ status: 404 });
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
    const tools = [
      "--tools",
      "read,grep,find,ls,request_human_input,artifacts_list,artifacts_read",
      "--exclude-tools",
      "mcp__*",
    ];
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
      "assistant: tools: read,grep,find,ls,request_human_input,artifacts_list,artifacts_read",
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
      "assistant: tools: read,grep,find,ls,request_human_input,artifacts_list,artifacts_read",
    );
    // A side chat is never a worker chat to switch to.
    expect(await code(await server.request("POST", `/api/agents/${side.id}/activate`), 409)).toBe(
      "not_a_worker_chat",
    );
  });

  it("launches a planner workspace's chats read-only with the planner tools and model", async () => {
    await setup({
      roleDefaults: async (role) =>
        role === "planner" ? { provider: "fake", modelId: "plan-1" } : { modelId: "other" },
    });
    const { folder } = await makeAgent();
    const project = (
      await json<{ projects: { id: string; path: string }[] }>(
        await server.request("GET", "/api/projects"),
      )
    ).projects.find((p) => p.path === folder);
    const { workspace } = await json<{ workspace: Workspace }>(
      await server.request("POST", "/api/workspaces/planner", { projectId: project?.id }),
    );
    const { agent } = await json<{ agent: Agent }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    expect(agent).toMatchObject({ role: "planner", kind: "worker", active: true });
    await json(await prompt(agent.id, "tools"));
    await replied(agent.id, 2);

    const launch = launches()[0];
    // These two first, so a wrong tool list names the tool it got wrong and not the whole argv.
    // A planner chat starts read-only helpers with `start_helper`; the raw `subagent` tool could start a worker.
    const argv = launch?.argv ?? [];
    const plannerTools = argv[argv.indexOf("--tools") + 1]?.split(",") ?? [];
    expect(plannerTools).toContain("start_helper");
    expect(plannerTools).not.toContain("subagent");
    expect(launch?.argv).toEqual([
      "--mode",
      "rpc",
      "--no-extensions",
      "--session-dir",
      join(server.paths.sessions, workspace.id),
      "--provider",
      "fake",
      "--model",
      "plan-1",
      "--tools",
      "read,grep,find,ls,request_human_input,artifacts_list,artifacts_read,kanban_list_cards,kanban_read_card,kanban_add_card,kanban_update_card,web_search,fetch_content,get_search_content,start_helper",
      "--exclude-tools",
      "mcp__*",
    ]);
    expect(launch?.env.PI_SPORE_CHAT_KIND).toBe("planner");
    expect(server.agentTokens.find(launch?.env.PI_SPORE_TOKEN)).toEqual({
      agentId: agent.id,
      workspaceId: workspace.id,
      readOnly: true,
    });

    expect(await code(await newChat(workspace.id, "side"), 409)).toBe("planner_no_side_chats");
    const { agent: next } = await json<{ agent: Agent }>(
      await newChat(workspace.id, "worker"),
      201,
    );
    expect(next).toMatchObject({ role: "planner", kind: "worker", active: true });
  });

  it("starts a planner chat on the orchestrator's model and thinking when no planner override is set", async () => {
    await setup({
      roleDefaults: async (role) =>
        role === "orchestrator" ? { provider: "fake", modelId: "orch-1", thinking: "xhigh" } : {},
    });
    const { folder } = await makeAgent();
    const project = (
      await json<{ projects: { id: string; path: string }[] }>(
        await server.request("GET", "/api/projects"),
      )
    ).projects.find((p) => p.path === folder);
    const { workspace } = await json<{ workspace: Workspace }>(
      await server.request("POST", "/api/workspaces/planner", { projectId: project?.id }),
    );
    const { agent } = await json<{ agent: Agent }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );
    await json(await prompt(agent.id, "hello"));
    await until(() => existsSync(record));
    const argv = launches()[0]?.argv ?? [];
    expect(argv.slice(argv.indexOf("--provider"), argv.indexOf("--tools"))).toEqual([
      "--provider",
      "fake",
      "--model",
      "orch-1",
      "--thinking",
      "xhigh",
    ]);
  });

  it("counts side chats against the live-agent limit", async () => {
    await setup({ maxLive: 1 });
    const { agentId: worker, workspaceId } = await makeAgent();
    await json(await prompt(worker, "slow:60000"));
    await until(() => status(worker) === "busy");
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

  const close = (agentId: string) => server.request("POST", `/api/agents/${agentId}/close`);

  it("closes a chat for good: it leaves the list, Home, and open pages, and its files stay", async () => {
    await setup();
    const { agentId: worker, workspaceId } = await makeAgent();
    const { agent: side } = await json<{ agent: Agent }>(await newChat(workspaceId, "side"), 201);
    await json(await prompt(side.id, "look"));
    await replied(side.id, 2);
    const file = sessionFile(side.id);
    expect(file).toBeTruthy();
    const before = server.events.eventsOf("agents:list").length;

    await json(await close(side.id));

    expect((await chats(workspaceId)).map((chat) => chat.id)).toEqual([worker]);
    expect(agentsModule.manager().liveCount()).toBe(0);
    expect(
      agentsModule
        .manager()
        .attention()
        .map((entry) => entry.agent.id),
    ).toEqual([worker]);
    const [snapshot] = await server.events.snapshot("agents:list");
    expect(reduceAgentList([], snapshot).map((agent) => agent.id)).toEqual([worker]);
    const events = server.events.eventsOf("agents:list").slice(before);
    expect(events.at(-1)).toEqual({ type: "removed", id: side.id });
    expect(reduceAgentList([{ ...side, status: "idle" }], events.at(-1)).length).toBe(0);
    expect(sessionFile(side.id)).toBe(file);
    // Closing twice is fine.
    await json(await close(side.id));
  });

  it("does not close a chat that is working", async () => {
    await setup();
    const { agentId, workspaceId } = await makeAgent();
    await json(await prompt(agentId, "slow:400"));
    await until(() => status(agentId) === "busy");
    expect(await code(await close(agentId), 409)).toBe("chat_busy");
    expect((await chats(workspaceId)).map((chat) => chat.id)).toEqual([agentId]);
  });

  it("starts a fresh worker chat after the active one is closed, and cannot reopen the closed one", async () => {
    await setup();
    const { agentId: first, workspaceId } = await makeAgent();
    await json(await prompt(first, "one"));
    await replied(first, 2);

    await json(await close(first));
    expect(await chats(workspaceId)).toEqual([]);
    expect(agentsModule.manager().liveCount()).toBe(0);

    const { agent: second } = await json<{ agent: Agent }>(
      await server.request("POST", "/api/agents", { workspaceId }),
      201,
    );
    expect(second).toMatchObject({ kind: "worker", active: true });
    expect(second.id).not.toBe(first);
    expect(await code(await prompt(first, "again"), 409)).toBe("chat_inactive");
    expect(await code(await server.request("POST", `/api/agents/${first}/activate`), 409)).toBe(
      "chat_closed",
    );
    expect((await chats(workspaceId)).map((chat) => chat.id)).toEqual([second.id]);
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
      ALTER TABLE agents_deliveries DROP COLUMN job_id;
      ALTER TABLE agents_deliveries DROP COLUMN options;
      DELETE FROM core_migrations WHERE module = 'agents' AND version >= 4;
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

  it("calls onChange with children for each list change and helpers only for a new running count", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    const changes: AgentChange[] = [];
    probe.agents().onChange((id, change) => {
      if (id === agentId && (change === "children" || change === "helpers")) changes.push(change);
    });

    await json(await helper(agentId, "run-1", "running"));
    await json(await helper(agentId, "run-1", "running"));
    await json(await helper(agentId, "run-2", "queued", "worker"));
    await until(() => latest(agentId)?.length === 2);
    expect(changes).toEqual(["children", "helpers", "children"]);

    await json(await server.request("POST", `/api/agents/${agentId}/stop`));
    await until(() => latest(agentId)?.length === 0);
    expect(changes.slice(3)).toEqual(["children"]);
  });

  it("calls onChange with children alone when a running helper's current tool changes", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    await json(await helper(agentId, "run-1", "running"));
    await until(() => latest(agentId)?.length === 1);
    const changes: AgentChange[] = [];
    probe.agents().onChange((id, change) => {
      if (id === agentId && (change === "children" || change === "helpers")) changes.push(change);
    });

    await json(await prompt(agentId, "helper:run-1:scout:running:read"));
    await json(await prompt(agentId, "helper:run-1:scout:running:read"));
    await json(await prompt(agentId, "helper:run-1:scout:running:bash"));
    await until(() => latest(agentId)?.[0]?.currentTool === "bash");
    expect(changes).toEqual(["children", "children"]);
  });

  it("gives the live model, the routed model of the newest answer, and the child runs", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "hello"));
    await until(() => status(agentId) === "idle");
    // The answer ran on the agent's own model, so nothing was routed elsewhere.
    expect(probe.agents().liveState(agentId)).toEqual({ model: "fake/fake-1", children: [] });

    await json(await helper(agentId, "run-1", "running"));
    await until(() => latest(agentId)?.length === 1);
    await json(
      await server.request("POST", `/api/agents/${agentId}/model`, {
        provider: "fake",
        modelId: "fake-2",
      }),
    );
    const state = probe.agents().liveState(agentId);
    expect(state).toMatchObject({ model: "fake/fake-2", routedModel: "fake/fake-1" });
    expect(state.children.map((run) => run.id)).toEqual(["run-1"]);
    expect(() => probe.agents().liveState("nope")).toThrow(/No agent nope/);
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

  it("counts running helpers in the agent view and the list, and drops the count when they end", async () => {
    await setup();
    const { agentId } = await makeAgent();
    await json(await prompt(agentId, "hello"));
    await until(() => statuses(agentId).filter((s) => s === "idle").length >= 2);
    // A helper command is a prompt, which clears the reply's wait; clear it first so only helper changes publish.
    await json(await server.request("POST", `/api/agents/${agentId}/seen`));
    const view = async () =>
      (await json<{ agent: Agent }>(await server.request("GET", `/api/agents/${agentId}`))).agent;
    const before = server.events.eventsOf("agents:list").length;
    const listed = () =>
      (server.events.eventsOf("agents:list").slice(before) as { agent?: Agent }[]).flatMap(
        (event) => (event.agent ? [event.agent.helpersRunning] : []),
      );

    await json(await helper(agentId, "run-1", "running"));
    await json(await helper(agentId, "run-2", "queued", "worker"));
    await until(() => latest(agentId)?.length === 2);
    expect((await view()).helpersRunning).toBe(1);
    await json(await helper(agentId, "run-2", "running", "worker"));
    await until(() => listed().at(-1) === 2);

    await json(await helper(agentId, "run-1", "complete"));
    await json(await helper(agentId, "run-2", "complete", "worker"));
    await until(() => listed().length === 4);
    expect(listed()).toEqual([1, 2, 1, undefined]);
    expect(await view()).not.toHaveProperty("helpersRunning");
  });

  it("puts the working-for label on the agent view and the list, and removes it with undefined", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    const view = async () =>
      (await json<{ agent: Agent }>(await server.request("GET", `/api/agents/${agentId}`))).agent;
    const before = server.events.eventsOf("agents:list").length;
    const listed = () =>
      (server.events.eventsOf("agents:list").slice(before) as { agent?: Agent }[]).flatMap(
        (event) => (event.agent ? [event.agent.workingFor] : []),
      );

    probe.agents().setWorkingFor(agentId, "pipelines", "Pipeline: gates");
    probe.agents().setWorkingFor(agentId, "pipelines", "Pipeline: gates");
    expect((await view()).workingFor).toBe("Pipeline: gates");
    await until(() => listed().length >= 1);
    expect(listed()).toEqual(["Pipeline: gates"]);

    probe.agents().setWorkingFor(agentId, "pipelines", undefined);
    probe.agents().setWorkingFor(agentId, "pipelines", undefined);
    expect(await view()).not.toHaveProperty("workingFor");
    await until(() => listed().length >= 2);
    expect(listed()).toEqual(["Pipeline: gates", undefined]);
  });

  it("publishes the working-for label on the agent's own stream, so an open chat follows it", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    const before = events(agentId).length;
    const labels = () =>
      events(agentId)
        .slice(before)
        .flatMap((event) => (event.type === "agent" ? [event.agent.workingFor] : []));

    probe.agents().setWorkingFor(agentId, "pipelines", "Pipeline: gates");
    probe.agents().setWorkingFor(agentId, "pipelines", "Pipeline: gates");
    probe.agents().setWorkingFor(agentId, "pipelines", undefined);
    expect(labels()).toEqual(["Pipeline: gates", undefined]);
  });

  it("keeps one working-for label per source, joins them in source order, and clears one source at a time", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    const view = async () =>
      (await json<{ agent: Agent }>(await server.request("GET", `/api/agents/${agentId}`))).agent;
    const before = events(agentId).length;
    const labels = () =>
      events(agentId)
        .slice(before)
        .flatMap((event) => (event.type === "agent" ? [event.agent.workingFor] : []));

    probe.agents().setWorkingFor(agentId, "pipelines", "Pipeline: implement");
    probe.agents().setWorkingFor(agentId, "runs", 'Merging lane "A": gate test');
    expect((await view()).workingFor).toBe('Pipeline: implement; Merging lane "A": gate test');

    probe.agents().setWorkingFor(agentId, "pipelines", undefined);
    expect((await view()).workingFor).toBe('Merging lane "A": gate test');

    probe.agents().setWorkingFor(agentId, "runs", undefined);
    expect(await view()).not.toHaveProperty("workingFor");
    expect(labels()).toEqual([
      "Pipeline: implement",
      'Pipeline: implement; Merging lane "A": gate test',
      'Merging lane "A": gate test',
      undefined,
    ]);
  });

  it("publishes nothing when a source sets the label it already has", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { agentId } = await makeAgent();
    probe.agents().setWorkingFor(agentId, "pipelines", "Pipeline: implement");
    probe.agents().setWorkingFor(agentId, "runs", 'Merging lane "A": gate test');
    const before = events(agentId).length;

    probe.agents().setWorkingFor(agentId, "pipelines", "Pipeline: implement");
    probe.agents().setWorkingFor(agentId, "runs", 'Merging lane "A": gate test');
    expect(events(agentId).slice(before)).toEqual([]);
  });

  describe("router status (R4.5)", () => {
    const routerStatus = async (agentId: string) =>
      (await json<{ agent: Agent }>(await server.request("GET", `/api/agents/${agentId}`))).agent
        .routerStatus;
    const busyAgent = async (slowMs = 60_000) => {
      await setup();
      const { agentId } = await makeAgent();
      await json(await prompt(agentId, `slow:${slowMs}`));
      await until(() => status(agentId) === "busy");
      return agentId;
    };

    it("shows the router's waiting text on the agent view and the list, and drops it when cleared", async () => {
      const agentId = await busyAgent();
      const before = server.events.eventsOf("agents:list").length;
      await json(await prompt(agentId, "router-status:Waiting for local/qwen"));
      await until(async () => (await routerStatus(agentId)) === "Waiting for local/qwen");
      const listed = () =>
        (server.events.eventsOf("agents:list").slice(before) as { agent?: Agent }[]).flatMap(
          (event) => (event.agent ? [event.agent.routerStatus] : []),
        );
      expect(listed().at(-1)).toBe("Waiting for local/qwen");

      await json(await prompt(agentId, "router-status-clear"));
      await until(async () => (await routerStatus(agentId)) === undefined);
      expect(listed().at(-1)).toBeUndefined();
    });

    it("drops the text when the run settles", async () => {
      // The fake only sees an abort between reply chunks, so the reply is short.
      const agentId = await busyAgent(400);
      await json(await prompt(agentId, "router-status:Waiting for local/qwen"));
      await until(async () => (await routerStatus(agentId)) !== undefined);
      await json(await server.request("POST", `/api/agents/${agentId}/abort`));
      await until(() => status(agentId) === "idle");
      expect(await routerStatus(agentId)).toBeUndefined();
    });

    it("drops the text when the process exits", async () => {
      const agentId = await busyAgent();
      await json(await prompt(agentId, "router-status:Waiting for local/qwen"));
      await until(async () => (await routerStatus(agentId)) !== undefined);
      await json(await server.request("POST", `/api/agents/${agentId}/stop`));
      await until(() => status(agentId) === "stopped");
      expect(await routerStatus(agentId)).toBeUndefined();
    });
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

describe("workspace working labels (R7)", () => {
  const DAY = 86_400_000;
  const START = 1_700_000_000_000;

  /** The `agents:working` maps published so far, oldest first. Each one is the whole map. */
  const maps = () =>
    (server.events.eventsOf("agents:working") as { workspaces: Record<string, string> }[]).map(
      (event) => event.workspaces,
    );

  /**
   * Labels every stored workspace while the module graph is set up. The retention sweep that deletes an archived
   * workspace runs after every setup, so the labels are in place when the delete hook runs.
   */
  const bootLabelProbe = (): ServerModule => ({
    id: "workspace-working-probe",
    requires: ["agents", "workspaces"],
    core: false,
    setup(host) {
      const agents = host.use(AgentsKey);
      for (const row of host.store.all<{ id: string }>("SELECT id FROM workspaces_workspaces"))
        agents.setWorkspaceWorkingFor(row.id, "Pipeline: gates");
    },
  });

  it("marks a workspace as working, publishes the whole map once per change, and clears it", async () => {
    const probe = agentsProbe();
    await setup({}, {}, {}, [probe.module]);
    const { workspaceId } = await makeAgent("labelled");
    const { workspaceId: otherId } = await makeAgent("also-labelled");
    const changed: string[] = [];
    probe.agents().onWorkspaceWorkingFor((id) => changed.push(id));

    probe.agents().setWorkspaceWorkingFor(workspaceId, "Pipeline: gates");
    probe.agents().setWorkspaceWorkingFor(workspaceId, "Pipeline: gates");
    expect(maps()).toEqual([{ [workspaceId]: "Pipeline: gates" }]);
    expect(changed).toEqual([workspaceId]);
    expect(probe.agents().workspacesWorkingFor()).toEqual(
      new Map([[workspaceId, "Pipeline: gates"]]),
    );
    // A page that opens later catches up on the current map, as it does with `agents:list`.
    expect(await server.events.snapshot("agents:working")).toEqual([
      { type: "working", workspaces: { [workspaceId]: "Pipeline: gates" } },
    ]);

    probe.agents().setWorkspaceWorkingFor(otherId, "Pipeline: implement");
    expect(maps().at(-1)).toEqual({
      [workspaceId]: "Pipeline: gates",
      [otherId]: "Pipeline: implement",
    });

    probe.agents().setWorkspaceWorkingFor(workspaceId, undefined);
    probe.agents().setWorkspaceWorkingFor(workspaceId, undefined);
    expect(maps().at(-1)).toEqual({ [otherId]: "Pipeline: implement" });
    expect(changed).toEqual([workspaceId, otherId, workspaceId]);
    expect(probe.agents().workspacesWorkingFor()).toEqual(
      new Map([[otherId, "Pipeline: implement"]]),
    );
  });

  it("drops a workspace's label when retention deletes it, and keeps the others", async () => {
    const home = join(scratch, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ retention: { days: 30 } }));
    const probe = agentsProbe();
    const modules = [probe.module, bootLabelProbe()];
    await setup({}, {}, { home, startAt: START }, modules);
    const gone = await makeAgent("gone");
    const kept = await makeAgent("kept");
    await json(await server.request("POST", `/api/workspaces/${gone.workspaceId}/archive`, {}));
    await agentsModule.manager().stopAll();
    server.close();

    // A month later the sweep deletes the archived workspace, so the agents module drops its label.
    await setup({}, {}, { home, startAt: START + 31 * DAY, firstId: 1_000 }, modules);

    expect(probe.agents().workspacesWorkingFor().has(gone.workspaceId)).toBe(false);
    expect(probe.agents().workspacesWorkingFor().get(kept.workspaceId)).toBe("Pipeline: gates");
    expect(maps().at(-1)).toEqual({ [kept.workspaceId]: "Pipeline: gates" });
  });
});

describe("deliveries on the job runner", () => {
  const delivery = () =>
    server.store.get<{
      state: string;
      attempts: number;
      error: string | null;
      job_id: string | null;
    }>("SELECT state, attempts, error, job_id FROM agents_deliveries");

  it("gives a pending row from before the runner a job and sends it, oldest first", async () => {
    const home = join(scratch, "home");
    await setup({}, {}, { home });
    const { agentId } = await makeAgent();
    await agentsModule.manager().stopAll();
    server.close();

    // Rows as an older version left them: pending, with no job.
    const db = new DatabaseSync(server.paths.database);
    for (const [id, message, createdAt] of [
      ["d2", "second", 2],
      ["d1", "first", 1],
    ] as const)
      db.prepare(
        "INSERT INTO agents_deliveries (id, agent_id, message, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
      ).run(id, agentId, message, createdAt);
    db.close();

    await setup({}, {}, { home, firstId: 1_000 });
    await until(
      () => server.store.all("SELECT 1 FROM agents_deliveries WHERE state = 'done'").length === 2,
    );
    // A row is done once Pi accepts it, before the reply lands in the transcript. Wait for the last line.
    await until(async () => texts(await chat(agentId)).includes("assistant: echo: second"));
    expect(texts(await chat(agentId))).toEqual([
      "user: first",
      "assistant: echo: first",
      "user: second",
      "assistant: echo: second",
    ]);
    expect(
      server.store
        .all<{ job_id: string | null }>("SELECT job_id FROM agents_deliveries")
        .every((row) => row.job_id),
    ).toBe(true);
  });

  /** Pi exits at once while the returned flag file exists. */
  async function failingPi() {
    // Pi exits at once while the flag file exists, so the start fails without waiting for a timeout.
    const flag = join(scratch, "pi-down");
    const wrapper = join(scratch, "pi-wrapper.mjs");
    writeFileSync(flag, "");
    writeFileSync(
      wrapper,
      `import { existsSync } from "node:fs";\nif (existsSync(${JSON.stringify(flag)})) process.exit(1);\nawait import(${JSON.stringify(FAKE_PI)});\n`,
    );
    let deliver: (agentId: string, message: string) => void = () => {
      throw new Error("not set up");
    };
    const deliverer: ServerModule = {
      id: "deliverer",
      requires: ["agents"],
      core: false,
      setup(host) {
        deliver = host.use(AgentsKey).deliver;
      },
    };
    await setup({ pi: { command: process.execPath, args: [wrapper] } }, {}, {}, [deliverer]);
    return { deliver: (agentId: string, message: string) => deliver(agentId, message), flag };
  }

  it("keeps a row pending with its error when the send fails, and sends it after a wake", async () => {
    const { deliver, flag } = await failingPi();
    const { agentId, workspaceId, folder } = await makeAgent();
    const gate = join(folder, ".fake-pi-hold-turn");
    writeFileSync(gate, "");

    deliver(agentId, "hello");
    await until(() => delivery()?.attempts === 1);
    expect(delivery()).toMatchObject({ state: "pending", attempts: 1, error: expect.any(String) });

    rmSync(flag);
    await json(await server.request("POST", `/api/workspaces/${workspaceId}/park`));
    const settled = new Promise<void>((resolve) => {
      const publish = server.events.publish.bind(server.events);
      const listener = vi.spyOn(server.events, "publish").mockImplementation((topic, raw) => {
        publish(topic, raw);
        const event = raw as AgentEvent;
        if (
          topic === `agent:${agentId}` &&
          event.type === "pi" &&
          (event.event as { type: string }).type === "agent_settled"
        ) {
          listener.mockRestore();
          resolve();
        }
      });
    });
    await json(await server.request("POST", `/api/workspaces/${workspaceId}/resume`));
    await until(() => delivery()?.state === "done");
    expect(delivery()).toMatchObject({ attempts: 2, error: null });
    // Acceptance does not imply a completed turn: Pi has not emitted its transcript yet.
    expect(texts(await chat(agentId))).toEqual([]);
    rmSync(gate);
    await settled;
    expect(texts(await chat(agentId))).toEqual(["user: hello", "assistant: echo: hello"]);
  });

  it("tries a failed row again, first, when a new message comes", async () => {
    const { deliver, flag } = await failingPi();
    const { agentId } = await makeAgent();

    deliver(agentId, "first");
    await until(() => delivery()?.attempts === 1);
    rmSync(flag);
    deliver(agentId, "second");
    // A row is done once Pi accepts it, before the reply lands in the transcript. Wait for the last line.
    await until(async () => texts(await chat(agentId)).includes("assistant: echo: second"));
    expect(texts(await chat(agentId))).toEqual([
      "user: first",
      "assistant: echo: first",
      "user: second",
      "assistant: echo: second",
    ]);
  });

  it("keeps a typed prompt behind a pending row, with its images and steer choice", async () => {
    const { deliver, flag } = await failingPi();
    const { agentId } = await makeAgent();

    deliver(agentId, "first");
    await until(() => delivery()?.attempts === 1);
    rmSync(flag);
    await json(
      await server.request("POST", `/api/agents/${agentId}/prompt`, {
        message: "second",
        images: [{ mimeType: "image/png", data: FAKE_PNG }],
        whileBusy: "followUp",
      }),
    );
    // A row is done once Pi accepts it, before the reply lands in the transcript. Wait for the last line.
    await until(async () =>
      texts(await chat(agentId)).includes("assistant: echo: second [1 images]"),
    );
    const lines = texts(await chat(agentId));
    expect(lines.slice(0, 2)).toEqual(["user: first", "assistant: echo: first"]);
    expect(lines.slice(2)).toEqual(["user: second", "assistant: echo: second [1 images]"]);
  });

  describe("moving and dropping a chat's pending rows", () => {
    const pendingOf = (agentId: string) =>
      server.store.all<{ message: string }>(
        "SELECT message FROM agents_deliveries WHERE agent_id = ? AND state = 'pending' ORDER BY created_at, id",
        agentId,
      );

    /** An older worker chat that has two pending rows, because only the active chat receives them. */
    async function olderChatWithRows() {
      const probe = agentsProbe();
      await setup({}, {}, {}, [probe.module]);
      const { agentId: older, workspaceId } = await makeAgent();
      const { agent: newer } = await json<{ agent: Agent }>(
        await server.request("POST", "/api/agents/chats", { workspaceId, kind: "worker" }),
        201,
      );
      probe.agents().deliver(older, "first");
      probe.agents().deliver(older, "second");
      return { agents: probe.agents(), older, newer: newer.id };
    }

    it("moves the pending rows to another chat in order, and that chat receives them", async () => {
      const { agents, older, newer } = await olderChatWithRows();
      expect(pendingOf(older)).toHaveLength(2);

      server.store.transaction(() => agents.moveDeliveries(older, newer));
      // A row is done once Pi accepts it, before the reply lands in the transcript. Wait for the last line.
      await until(async () => texts(await chat(newer)).includes("assistant: echo: second"));

      expect(pendingOf(newer)).toEqual([]);
      expect(pendingOf(older)).toEqual([]);
      expect(texts(await chat(newer))).toEqual([
        "user: first",
        "assistant: echo: first",
        "user: second",
        "assistant: echo: second",
      ]);
      expect(texts(await chat(older))).toEqual([]);
    });

    it("drops the pending rows, so nothing is sent when the chat runs again", async () => {
      const { agents, older } = await olderChatWithRows();

      server.store.transaction(() => agents.dropDeliveries(older));
      expect(pendingOf(older)).toEqual([]);
      expect(server.store.all("SELECT 1 FROM agents_deliveries")).toEqual([]);

      const open = server.services.jobs.list({
        kind: "agents.delivery",
        states: ["running", "waiting", "interrupted"],
      });
      expect(open).toEqual([]);

      await json(await server.request("POST", `/api/agents/${older}/activate`));
      expect(texts(await chat(older))).toEqual([]);
    });
  });
});

describe("stage agents (R6)", () => {
  let api: Agents;
  const probe: ServerModule = {
    id: "stage-probe",
    requires: ["agents"],
    core: false,
    setup(host) {
      api = host.use(AgentsKey);
    },
  };
  const setupStages = () =>
    setup(
      {
        roleDefaults: async (role) => ({
          provider: "fake",
          modelId: "fake-1",
          thinking: role === "reviewer" ? "low" : "high",
        }),
      },
      {},
      {},
      [probe],
    );
  const replied = (agentId: string, count: number) =>
    until(() => statuses(agentId).filter((s) => s === "idle").length >= count);
  /** Creates the stage and queues its prompt in one transaction, as a pipeline does. */
  const start = (
    workspaceId: string,
    stage: Parameters<Agents["createStage"]>[1],
    message = "tools",
  ) =>
    server.store.transaction(() => {
      const agent = api.createStage(workspaceId, stage);
      api.deliver(agent.id, message);
      return agent;
    });

  it("starts a reviewer through its delivery with read-only tools, its model, and a read-only token", async () => {
    await setupStages();
    const { agentId: worker, workspaceId } = await makeAgent();
    await json(await prompt(worker, "one"));
    await until(() => statuses(worker).includes("idle"));

    const stage = start(workspaceId, {
      role: "reviewer",
      title: "Review 1",
      model: "fake/other-1",
    });
    expect(stage).toMatchObject({
      kind: "stage",
      role: "reviewer",
      active: true,
      title: "Review 1",
    });
    await replied(stage.id, 1);

    // The stage runs next to the live worker chat.
    const launch = launches()[1];
    expect(launch?.argv).toEqual([
      "--mode",
      "rpc",
      "--no-extensions",
      "--session-dir",
      join(server.paths.sessions, workspaceId),
      "--provider",
      "fake",
      "--model",
      "other-1",
      "--thinking",
      "low",
      "--tools",
      "read,grep,find,ls,artifacts_list,artifacts_read,report,ask_coordinator,ask_orchestrator",
      "--exclude-tools",
      "mcp__*",
    ]);
    expect(launch?.env).toMatchObject({
      PI_SPORE_CHAT_KIND: "stage",
      PI_SPORE_STAGE_ROLE: "reviewer",
    });
    expect(server.agentTokens.find(launch?.env.PI_SPORE_TOKEN)).toEqual({
      agentId: stage.id,
      workspaceId,
      readOnly: true,
    });
    expect(agentsModule.manager().liveCount()).toBe(2);
  });

  it("gives a stage worker no contact_supervisor, and a writable token, with its role's thinking level", async () => {
    await setupStages();
    const { workspaceId } = await makeAgent();
    const stage = start(workspaceId, { role: "worker", title: "Implement" });
    await replied(stage.id, 1);

    const launch = launches()[0];
    expect(launch?.argv).not.toContain("--tools");
    // pi-subagents' contact_supervisor works only in a child it started, so a stage agent must not have it.
    expect(launch?.argv).toEqual(expect.arrayContaining(["--exclude-tools", "contact_supervisor"]));
    expect(launch?.argv).toEqual(expect.arrayContaining(["--thinking", "high"]));
    expect(launch?.env).toMatchObject({
      PI_SPORE_CHAT_KIND: "stage",
      PI_SPORE_STAGE_ROLE: "worker",
    });
    expect(server.agentTokens.find(launch?.env.PI_SPORE_TOKEN)).toEqual({
      agentId: stage.id,
      workspaceId,
    });
  });

  it("runs an adversarial reviewer read-only too", async () => {
    await setupStages();
    const { workspaceId } = await makeAgent();
    const stage = start(workspaceId, { role: "adversarial-reviewer", title: "Attack" });
    await replied(stage.id, 1);
    const launch = launches()[0];
    expect(launch?.argv).toEqual(expect.arrayContaining(["--exclude-tools", "mcp__*"]));
    expect(server.agentTokens.find(launch?.env.PI_SPORE_TOKEN)).toMatchObject({ readOnly: true });
  });

  it("starts no process until the first delivery, and none when the transaction rolls back", async () => {
    await setupStages();
    const { workspaceId } = await makeAgent();
    const stage = api.createStage(workspaceId, { role: "reviewer", title: "Quiet" });
    expect(stage.status).toBe("stopped");
    expect(agentsModule.manager().liveCount()).toBe(0);
    expect(existsSync(record)).toBe(false);

    expect(() =>
      server.store.transaction(() => {
        api.deliver(stage.id, "tools");
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(record)).toBe(false);
  });

  it("refuses a stage for an unknown workspace with 404", async () => {
    await setupStages();
    expect(() => api.createStage("nope", { role: "reviewer", title: "x" })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("leaves the workspace's chats alone: one active worker chat stays, and the stage is listed after side chats", async () => {
    await setupStages();
    const { agentId: worker, workspaceId } = await makeAgent();
    const stage = api.createStage(workspaceId, { role: "reviewer", title: "R" });
    const { agent: side } = await json<{ agent: Agent }>(
      await server.request("POST", "/api/agents/chats", { workspaceId, kind: "side" }),
      201,
    );
    const { agent: fresh } = await json<{ agent: Agent }>(
      await server.request("POST", "/api/agents/chats", { workspaceId, kind: "worker" }),
      201,
    );
    const { agents } = await json<{ agents: Agent[] }>(
      await server.request("GET", `/api/agents?workspaceId=${workspaceId}`),
    );
    expect(agents.map((agent) => agent.id)).toEqual([fresh.id, side.id, stage.id, worker]);
    expect(agents.find((agent) => agent.id === stage.id)?.active).toBe(true);
  });

  it("answers 409 stage_model_fixed when the model of a stage changes", async () => {
    await setupStages();
    const { workspaceId } = await makeAgent();
    const stage = api.createStage(workspaceId, { role: "reviewer", title: "R", model: "fake/a-1" });
    const response = await server.request("POST", `/api/agents/${stage.id}/model`, {
      provider: "fake",
      modelId: "b-1",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "stage_model_fixed",
    );
    expect(existsSync(record)).toBe(false);
  });

  it("lists the distinct models Pi recorded, in first-seen order, and none before a session", async () => {
    await setupStages();
    const { agentId, workspaceId } = await makeAgent();
    expect(await api.modelsUsed(agentId)).toEqual([]);
    await json(await prompt(agentId, "one"));
    await replied(agentId, 1);
    await json(
      await server.request("POST", `/api/agents/${agentId}/model`, {
        provider: "other",
        modelId: "b-2",
      }),
    );
    await json(await prompt(agentId, "two"));
    await replied(agentId, 2);
    await json(await prompt(agentId, "three"));
    await replied(agentId, 3);
    expect(await api.modelsUsed(agentId)).toEqual(["fake/fake-1", "other/b-2"]);

    const stage = api.createStage(workspaceId, { role: "reviewer", title: "R" });
    expect(await api.modelsUsed(stage.id)).toEqual([]);
  });

  it("lists the session file and role of each agent that has a session, for one workspace", async () => {
    await setupStages();
    const { agentId, workspaceId } = await makeAgent();
    const other = await makeAgent("other");
    expect(api.sessionRoles(workspaceId)).toEqual([]);
    await json(await prompt(agentId, "one"));
    await replied(agentId, 1);
    const stage = start(workspaceId, { role: "reviewer", title: "R" });
    await replied(stage.id, 1);
    api.createStage(workspaceId, { role: "worker", title: "No session yet" });
    await json(await prompt(other.agentId, "one"));
    await replied(other.agentId, 1);

    const files = (id: string) =>
      server.store.get<{ session_file: string }>(
        "SELECT session_file FROM agents_agents WHERE id = ?",
        id,
      )?.session_file;
    expect(api.sessionRoles(workspaceId)).toEqual([
      { sessionFile: files(agentId), role: "orchestrator" },
      { sessionFile: files(stage.id), role: "reviewer" },
    ]);
  });

  describe("turnError", () => {
    /** A stage agent whose turns follow a fake Pi script, started the way a pipeline does. */
    const scripted = async (entries: unknown[]) => {
      const script = join(scratch, "script.json");
      writeFileSync(script, JSON.stringify({ worker: entries }));
      await setup(
        { roleDefaults: async () => ({ provider: "fake", modelId: "fake-1", thinking: "high" }) },
        { FAKE_PI_SCRIPT: script },
        {},
        [probe],
      );
      const { workspaceId } = await makeAgent();
      return start(workspaceId, { role: "worker", title: "Implement" }, "go");
    };

    it("is undefined before a session and after a normal turn", async () => {
      await setupStages();
      const { agentId } = await makeAgent();
      expect(await api.turnError(agentId)).toBeUndefined();
      await json(await prompt(agentId, "one"));
      // The first idle is the start-up one.
      await replied(agentId, 2);
      expect(await api.turnError(agentId)).toBeUndefined();
    });

    it("returns the error text of a turn the provider refused", async () => {
      const stage = await scripted([{ error: "usage limit reached" }]);
      // The first idle is the start-up one, so wait for the turn's own end.
      await until(async () => (await api.turnError(stage.id)) !== undefined);
      expect(await api.turnError(stage.id)).toBe("usage limit reached");
    });

    it("returns the error of a message Pi refused, shows it on the agent, and clears it once a message gets in", async () => {
      const NO_KEY = "No API key found for anthropic.";
      const refuse = join(scratch, "refuse");
      writeFileSync(refuse, NO_KEY);
      await setup({}, { FAKE_PI_REFUSE_FILE: refuse }, {}, [probe]);
      const { workspaceId } = await makeAgent();
      const stage = start(workspaceId, { role: "worker", title: "Implement" }, "go");

      await until(async () => (await api.turnError(stage.id)) !== undefined);
      expect(await api.turnError(stage.id)).toBe(NO_KEY);
      expect(status(stage.id)).toBe("idle");
      expect(api.get(stage.id).deliveryError).toBe(NO_KEY);
      const { agent } = await json<{ agent: Agent }>(
        await server.request("GET", `/api/agents/${stage.id}`),
      );
      expect(agent.deliveryError).toBe(NO_KEY);

      rmSync(refuse);
      api.deliver(stage.id, "again");
      await until(() => api.get(stage.id).deliveryError === undefined);
    });

    it("returns the status error after a crash", async () => {
      const stage = await scripted(["crash"]);
      await until(() => status(stage.id) === "failed");
      expect(await api.turnError(stage.id)).toContain("boom: the fake agent crashed");
    });

    it("is undefined, and no models are used, while Pi has named a session file it has not written yet", async () => {
      await setupStages();
      const { agentId } = await makeAgent();
      await json(await prompt(agentId, "one"));
      // The first idle is the start-up one. Wait for the turn's own end, so Pi does not write the file after rmSync.
      await replied(agentId, 2);
      const file = server.store.get<{ session_file: string }>(
        "SELECT session_file FROM agents_agents WHERE id = ?",
        agentId,
      )?.session_file;
      // Pi reports the path before its first reply writes the file.
      rmSync(file as string);
      expect(await api.turnError(agentId)).toBeUndefined();
      expect(await api.modelsUsed(agentId)).toEqual([]);
    });

    it("throws a 404 for an unknown agent", async () => {
      await setupStages();
      await expect(api.turnError("nope")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("endedRun", () => {
    /** A stage agent whose turns follow a fake Pi script, started the way a pipeline does. */
    const scripted = async (entries: unknown[]) => {
      const script = join(scratch, "script.json");
      writeFileSync(script, JSON.stringify({ worker: entries }));
      await setup(
        { roleDefaults: async () => ({ provider: "fake", modelId: "fake-1", thinking: "high" }) },
        { FAKE_PI_SCRIPT: script },
        {},
        [probe],
      );
      const { workspaceId } = await makeAgent();
      return start(workspaceId, { role: "worker", title: "Implement" }, "go");
    };
    const assistantReplies = (agentId: string) =>
      events(agentId).filter(
        (event) =>
          event.type === "pi" &&
          (event.event as { type: string; message?: { role?: string } }).type === "message_end" &&
          (event.event as { message?: { role?: string } }).message?.role === "assistant",
      ).length;

    it("is false before a session and true after a plain turn ends", async () => {
      await setupStages();
      const { agentId } = await makeAgent();
      expect(await api.endedRun(agentId)).toBe(false);
      await json(await prompt(agentId, "one"));
      // The first idle is the start-up one.
      await replied(agentId, 2);
      expect(await api.endedRun(agentId)).toBe(true);
    });

    it("is false after an aborted run", async () => {
      await setupStages();
      const { agentId } = await makeAgent();
      // The fake checks for an abort between the two halves of its reply, so the run must outlast the request.
      await json(await prompt(agentId, "slow:1000"));
      await until(() => status(agentId) === "busy");
      await json(await server.request("POST", `/api/agents/${agentId}/abort`));
      await replied(agentId, 2);
      expect(await api.endedRun(agentId)).toBe(false);
    });

    it("is false for a turn the provider refused", async () => {
      const stage = await scripted([{ error: "usage limit reached" }]);
      await until(async () => (await api.turnError(stage.id)) !== undefined);
      expect(await api.endedRun(stage.id)).toBe(false);
    });

    it("is false while a hang turn is open, and the turn ends only on abort", async () => {
      const stage = await scripted(["hang"]);
      await until(() => assistantReplies(stage.id) >= 1);
      expect(await api.endedRun(stage.id)).toBe(false);

      await json(await server.request("POST", `/api/agents/${stage.id}/abort`));
      const settled = () =>
        events(stage.id).flatMap((event) =>
          event.type === "pi" && (event.event as { type: string }).type === "agent_settled"
            ? [event.event as { aborted?: boolean }]
            : [],
        );
      await until(() => settled().length === 1 && status(stage.id) === "idle");
      expect(settled()).toEqual([expect.objectContaining({ aborted: true })]);
      expect(await api.endedRun(stage.id)).toBe(false);
    });

    it("is true after a silent turn", async () => {
      const stage = await scripted(["silent"]);
      await until(() => assistantReplies(stage.id) >= 1 && status(stage.id) === "idle");
      expect(JSON.stringify(events(stage.id))).toContain("waiting (worker 0)");
      expect(await api.endedRun(stage.id)).toBe(true);
    });

    it("is false for a prompt Pi accepted but has not started", async () => {
      const stage = await scripted(["silent", "silent"]);
      await until(() => assistantReplies(stage.id) >= 1 && status(stage.id) === "idle");
      expect(await api.endedRun(stage.id)).toBe(true);
      const gate = join(scratch, "notes", ".fake-pi-hold-turn");
      writeFileSync(gate, "");

      api.deliver(stage.id, "next");
      const pending = () =>
        server.store.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM agents_deliveries WHERE agent_id = ? AND state = 'pending'",
          stage.id,
        )?.count;
      await until(() => pending() === 0);
      expect(status(stage.id)).toBe("idle");
      expect(await api.endedRun(stage.id)).toBe(false);

      rmSync(gate);
      await until(() => assistantReplies(stage.id) >= 2 && status(stage.id) === "idle");
      expect(await api.endedRun(stage.id)).toBe(true);
    });

    // Pi answers a command at once ("handled"), and rejects a plain prompt while it streams; neither starts a run.
    it.each([
      ["a command it handled", "helper-clear"],
      ["a prompt it rejected", "plain"],
    ])("stays false for a held prompt after %s", async (_name, message) => {
      const stage = await scripted(["silent", "silent"]);
      await until(() => assistantReplies(stage.id) >= 1 && status(stage.id) === "idle");
      const gate = join(scratch, "notes", ".fake-pi-hold-turn");
      writeFileSync(gate, "");
      api.deliver(stage.id, "next");
      const pending = () =>
        server.store.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM agents_deliveries WHERE agent_id = ? AND state = 'pending'",
          stage.id,
        )?.count;
      await until(() => pending() === 0);

      await prompt(stage.id, message);
      expect(status(stage.id)).toBe("idle");
      expect(await api.endedRun(stage.id)).toBe(false);

      rmSync(gate);
      await until(() => assistantReplies(stage.id) >= 2 && status(stage.id) === "idle");
      expect(await api.endedRun(stage.id)).toBe(true);
    });

    it("throws a 404 for an unknown agent", async () => {
      await setupStages();
      await expect(api.endedRun("nope")).rejects.toMatchObject({ status: 404 });
    });
  });

  it("renames an agent", async () => {
    await setupStages();
    const { agentId } = await makeAgent();
    api.rename(agentId, "New title");
    expect(api.get(agentId).title).toBe("New title");
  });

  it("exposes the role defaults", async () => {
    await setupStages();
    expect(await api.roleDefaults("reviewer")).toEqual({
      provider: "fake",
      modelId: "fake-1",
      thinking: "low",
    });
  });
});

describe("launch hooks", () => {
  const launchWith = async (...hooks: LaunchHook[]) => {
    const registrar: ServerModule = {
      id: "launch-hooks",
      requires: ["agents"],
      core: false,
      setup(host) {
        for (const hook of hooks) host.use(AgentsKey).addLaunchContext(hook);
      },
    };
    await setup({}, {}, {}, [registrar]);
  };
  const replied = (agentId: string) => until(() => statuses(agentId).includes("idle"));

  it("adds a hook's env and replaces the tools only for the workspace it names", async () => {
    let laneFolder = "";
    await launchWith((_agent, workspace) =>
      workspace.path === laneFolder
        ? { env: { PI_SPORE_LANE: "one" }, tools: ["a", "b"] }
        : undefined,
    );
    const lane = await makeAgent("lane");
    const plain = await makeAgent("plain");
    laneFolder = lane.folder;

    await json(await prompt(lane.agentId, "hi"));
    await replied(lane.agentId);
    await json(await prompt(plain.agentId, "hi"));
    await replied(plain.agentId);

    const [laneLaunch, plainLaunch] = launches();
    expect(laneLaunch?.env.PI_SPORE_LANE).toBe("one");
    expect(laneLaunch?.argv).toEqual(
      expect.arrayContaining(["--tools", "a,b", "--exclude-tools", "mcp__*"]),
    );
    expect(server.agentTokens.find(laneLaunch?.env.PI_SPORE_TOKEN)).not.toHaveProperty("readOnly");
    expect(plainLaunch?.env.PI_SPORE_LANE).toBeUndefined();
    expect(plainLaunch?.argv).not.toContain("--tools");
  });

  it("fails a planner chat's launch when a hook gives it tools", async () => {
    await launchWith(() => ({ tools: ["bash"] }));
    const { folder } = await makeAgent();
    const project = (
      await json<{ projects: { id: string; path: string }[] }>(
        await server.request("GET", "/api/projects"),
      )
    ).projects.find((p) => p.path === folder);
    const { workspace } = await json<{ workspace: Workspace }>(
      await server.request("POST", "/api/workspaces/planner", { projectId: project?.id }),
    );
    const { agent } = await json<{ agent: Agent }>(
      await server.request("POST", "/api/agents", { workspaceId: workspace.id }),
      201,
    );

    await prompt(agent.id, "hi");
    await until(() => statuses(agent.id).includes("failed"));
    const failed = events(agent.id).find(
      (event) => event.type === "status" && event.status === "failed",
    );
    expect(JSON.stringify(failed)).toContain("planner chat");
    expect(existsSync(record)).toBe(false);
  });

  it("fails the launch, naming the agent, when two hooks give tools", async () => {
    await launchWith(
      () => ({ tools: ["a"] }),
      () => ({ tools: ["b"] }),
    );
    const { agentId } = await makeAgent();

    await prompt(agentId, "hi");
    await until(() => statuses(agentId).includes("failed"));
    const failed = events(agentId).find(
      (event) => event.type === "status" && event.status === "failed",
    );
    expect(JSON.stringify(failed)).toContain(agentId);
  });
});
