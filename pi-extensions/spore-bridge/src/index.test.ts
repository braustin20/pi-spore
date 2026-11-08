import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sporeBridge from "./index.js";
import { RULES, RULES_SECTION, SIDE_RULES } from "./rules.js";

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  receipt: string | undefined;
  body: unknown;
}

type Reply =
  | { status?: number; body: unknown }
  | ((seen: Seen) => { status?: number; body: unknown });

let server: Server;
let seen: Seen[];
/** Answers by `METHOD path` (path without the query). */
let replies: Map<string, Reply[]>;

async function readBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(async () => {
  seen = [];
  replies = new Map();
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const entry: Seen = {
      method: request.method ?? "",
      path: `${url.pathname}${url.search}`,
      auth: request.headers.authorization,
      receipt: request.headers["idempotency-key"] as string | undefined,
      body: await readBody(request),
    };
    seen.push(entry);
    const queue = replies.get(`${entry.method} ${url.pathname}`) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const reply = typeof next === "function" ? next(entry) : next;
    response.writeHead(reply?.status ?? (reply ? 200 : 404), {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(reply?.body ?? { error: { code: "not_found", message: "no" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("PI_SPORE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  vi.stubEnv("PI_SPORE_TOKEN", "agent-token");
  vi.stubEnv("PI_CODING_AGENT_DIR", "/fake/agent");
});
afterEach(() => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  server.close();
});

const reply = (key: string, ...answers: Reply[]) => replies.set(key, answers);

interface Tool {
  name: string;
  execute(
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ): Promise<{ content: { text: string }[]; terminate?: boolean }>;
}

/** The parts of the extension API spore-bridge uses, recording what it registers. */
function fakePi() {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const api = {
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(name, handler),
  };
  // SAFETY: spore-bridge only calls registerTool and on.
  sporeBridge(api as unknown as ExtensionAPI);
  const tool = (name: string) => {
    const found = tools.get(name);
    if (!found) throw new Error(`No tool ${name}`);
    return found;
  };
  return { tools, handlers, tool };
}

const run = (status: string, extra: Record<string, unknown> = {}) => ({
  run: { id: "r1", action: "check", status, ...extra },
});

describe("spore-bridge", () => {
  it("adds nothing outside pi-spore and says why", async () => {
    vi.stubEnv("PI_SPORE_TOKEN", "");
    const pi = fakePi();
    expect(pi.tools.size).toBe(0);
    const notices: string[] = [];
    await pi.handlers.get("session_start")?.(
      {},
      { hasUI: true, ui: { notify: (message: string) => notices.push(message) } },
    );
    expect(notices[0]).toContain("PI_SPORE_TOKEN is not set");
  });

  it("files a question with the agent token and the tool call id as receipt, and ends the turn", async () => {
    reply("POST /api/bridge/questions", { status: 201, body: { question: { id: "q1" } } });
    const result = await fakePi()
      .tool("request_human_input")
      .execute("toolu_1", { question: "Which color?", choices: ["red", "blue"] });

    expect(seen).toEqual([
      {
        method: "POST",
        path: "/api/bridge/questions",
        auth: "Bearer agent-token",
        receipt: "toolu_1",
        body: { question: "Which color?", choices: ["red", "blue"] },
      },
    ]);
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toContain("question q1");
  });

  it("runs check until it ends and returns the outcome with the log tail", async () => {
    reply("POST /api/bridge/runs", { status: 201, body: run("running") });
    reply(
      "GET /api/bridge/runs/r1",
      { body: run("running") },
      { body: run("failed", { exitCode: 2 }) },
    );
    reply("GET /api/bridge/runs/r1/log", {
      body: {
        ...run("failed", { exitCode: 2 }),
        text: "src/a.ts(1,1): error TS1\n",
        truncated: true,
      },
    });
    const updates: unknown[] = [];

    const result = await fakePi()
      .tool("check")
      .execute("toolu_2", {}, undefined, (update) => updates.push(update));

    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "POST /api/bridge/runs",
      "GET /api/bridge/runs/r1?wait=25000",
      "GET /api/bridge/runs/r1?wait=25000",
      "GET /api/bridge/runs/r1/log",
    ]);
    expect(seen[0]).toMatchObject({ receipt: "toolu_2", body: { action: "check" } });
    expect(result.content[0]?.text).toBe(
      'Action "check" failed with exit code 2 (run r1).\nLast part of the log:\nsrc/a.ts(1,1): error TS1',
    );
    expect(updates.length).toBeGreaterThan(0);
  });

  it("turns a refusal into a tool error that quotes the server", async () => {
    reply("POST /api/bridge/runs", {
      status: 404,
      body: { error: { code: "action_not_found", message: 'No action "check"' } },
    });
    await expect(fakePi().tool("check").execute("toolu_3", {})).rejects.toThrow(
      'pi-spore refused runs: No action "check" (action_not_found)',
    );
  });

  it("names the server when it does not answer", async () => {
    vi.stubEnv("PI_SPORE_URL", "http://127.0.0.1:1");
    await expect(fakePi().tool("run_action").execute("toolu_4", { name: "test" })).rejects.toThrow(
      "The pi-spore server at http://127.0.0.1:1 did not answer",
    );
  });

  it("cancels the run when the tool call is aborted", async () => {
    const controller = new AbortController();
    reply("POST /api/bridge/runs", { status: 201, body: run("running") });
    reply("GET /api/bridge/runs/r1", () => {
      controller.abort();
      return { body: run("running") };
    });
    reply("POST /api/bridge/runs/r1/cancel", { body: run("cancelled") });

    await expect(
      fakePi().tool("run_action").execute("toolu_5", { name: "test" }, controller.signal),
    ).rejects.toThrow();
    await vi.waitFor(() =>
      expect(seen.some((entry) => entry.path === "/api/bridge/runs/r1/cancel")).toBe(true),
    );
  });

  const card = (extra: Record<string, unknown> = {}) => ({
    id: "c1",
    title: "Phase 1",
    body: "",
    labels: ["plan:x"],
    column: "backlog",
    blockedBy: [],
    blocked: false,
    ...extra,
  });

  it("adds a card with the tool call id as receipt", async () => {
    reply("POST /api/bridge/cards", { status: 201, body: { card: card() } });
    const result = await fakePi()
      .tool("kanban_add_card")
      .execute("toolu_k1", { title: "Phase 1", labels: ["plan:x"] });
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/api/bridge/cards",
        auth: "Bearer agent-token",
        receipt: "toolu_k1",
        body: { title: "Phase 1", labels: ["plan:x"] },
      },
    ]);
    expect(result.content[0]?.text).toBe("Added card c1  [backlog]  Phase 1  labels: plan:x");
  });

  it("passes a card's model to the board, and null clears it", async () => {
    reply("POST /api/bridge/cards", { status: 201, body: { card: card() } });
    reply("POST /api/bridge/cards/c1", { body: { card: card() } });
    await fakePi()
      .tool("kanban_add_card")
      .execute("toolu_m1", { title: "Phase 1", model: "fake/card-model" });
    await fakePi().tool("kanban_update_card").execute("toolu_m2", { cardId: "c1", model: null });
    expect(seen.map((call) => call.body)).toEqual([
      { title: "Phase 1", model: "fake/card-model" },
      { model: null },
    ]);
  });

  it("lists cards with their blockers and the project's workspaces", async () => {
    reply("GET /api/bridge/cards", {
      body: {
        cards: [
          card({
            id: "c2",
            title: "Phase 2",
            blocked: true,
            blockedBy: [{ kind: "card", id: "c1", title: "Phase 1", open: true }],
          }),
        ],
        workspaces: [{ id: "w1", name: "planner", current: true }],
      },
    });
    const result = await fakePi()
      .tool("kanban_list_cards")
      .execute("toolu_k2", { label: "plan:x" });
    expect(seen[0]?.path).toBe("/api/bridge/cards?label=plan%3Ax");
    expect(result.content[0]?.text).toBe(
      [
        "Cards (1):",
        "c2  [backlog]  Phase 2  labels: plan:x  blocked by: Phase 1 (c1)",
        "",
        "Active workspaces of this project:",
        "w1  planner  (this workspace)",
      ].join("\n"),
    );
  });

  it("asks to start a card in an existing workspace and ends the turn", async () => {
    reply("POST /api/bridge/cards/c1/start", {
      status: 201,
      body: { approval: { id: "a1", title: 'Start card "Phase 1"' } },
    });
    const result = await fakePi()
      .tool("kanban_start_card")
      .execute("toolu_k3", { cardId: "c1", workspaceId: "w2", reason: "Related work" });
    expect(seen[0]).toMatchObject({
      receipt: "toolu_k3",
      body: { target: { kind: "existing", workspaceId: "w2" }, reason: "Related work" },
    });
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toContain("approval a1");
  });

  it("asks for a new worktree by default, and refuses a mixed target without calling the server", async () => {
    reply("POST /api/bridge/cards/c1/start", {
      status: 201,
      body: { approval: { id: "a2", title: "x" } },
    });
    const pi = fakePi();
    await pi.tool("kanban_start_card").execute("toolu_k4", { cardId: "c1", reason: "Next" });
    expect(seen[0]?.body).toEqual({ target: { kind: "new", isolation: "new" }, reason: "Next" });
    await expect(
      pi
        .tool("kanban_start_card")
        .execute("toolu_k5", { cardId: "c1", workspaceId: "w2", isolation: "new", reason: "x" }),
    ).rejects.toThrow("not both");
    expect(seen).toHaveLength(1);
  });

  it("replaces the global AGENTS.md with the pi-spore rules and keeps project files", async () => {
    const options = {
      contextFiles: [
        { path: join("/fake/agent", "AGENTS.md"), content: "Use Orca terminals" },
        { path: "/work/project/AGENTS.md", content: "Project rules" },
      ],
      sections: {} as Record<string, string>,
    };
    await fakePi().handlers.get("before_agent_start")?.({ systemPromptOptions: options }, {});
    expect(options.contextFiles.map((file) => file.path)).toEqual(["/work/project/AGENTS.md"]);
    expect(options.sections[RULES_SECTION]).toBe(RULES);
  });

  it("gives the chat the orchestrator rules and keeps the pi-spore rules", async () => {
    const options = { contextFiles: [], sections: {} as Record<string, string> };
    await fakePi().handlers.get("before_agent_start")?.({ systemPromptOptions: options }, {});
    const rules = options.sections[RULES_SECTION] ?? "";
    expect(rules).toContain("You are the orchestrator of this workspace");
    expect(rules).toContain("before the first worker");
    expect(rules).toContain("Only one writer works in the worktree at a time");
    expect(rules).toContain("After three passes");
    expect(rules).toContain("`async: true`, never `async: false`");
    expect(rules).toContain("request_human_input");
    expect(rules).toContain("Never merge into the base branch");
    expect(rules).not.toContain("the worker of one workspace");
  });

  it("gives a side chat the side chat rules", async () => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", "side");
    const options = { contextFiles: [], sections: {} as Record<string, string> };
    await fakePi().handlers.get("before_agent_start")?.({ systemPromptOptions: options }, {});
    expect(options.sections[RULES_SECTION]).toBe(SIDE_RULES);
    expect(SIDE_RULES).toContain("next to the orchestrator");
    expect(SIDE_RULES).toContain("read-only");
  });

  it("refuses an unknown chat kind instead of guessing", () => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", "reviewer");
    const pi = fakePi();
    expect(pi.tools.size).toBe(0);
  });
});
