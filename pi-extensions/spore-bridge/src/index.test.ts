import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeEnv } from "./client.js";
import { STOP_REASON } from "./guard.js";
import sporeBridge from "./index.js";
import {
  COORDINATOR_RULES,
  LANE_RULES,
  RULES,
  RULES_SECTION,
  SIDE_RULES,
  STAGE_REVIEWER_RULES,
  STAGE_WORKER_RULES,
} from "./rules.js";

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
  // The test process stands in for the server, so ps can read it.
  vi.stubEnv("PI_SPORE_SERVER_PID", String(process.pid));
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
  parameters?: { properties?: Record<string, unknown> };
  promptGuidelines?: string[];
  executionMode?: "sequential" | "parallel";
  execute(
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ): Promise<{ content: { text: string }[]; details?: unknown; terminate?: boolean }>;
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
  run: { id: "r1", action: "check", status, logPath: "/logs/r1.log", ...extra },
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

  it("blocks a bash command that would stop the server and lets others run", async () => {
    const toolCall = fakePi().handlers.get("tool_call");
    const bash = (command: string) =>
      toolCall?.(
        { type: "tool_call", toolName: "bash", toolCallId: "t", input: { command } },
        {
          hasUI: false,
        },
      );
    expect(await bash(`kill ${process.pid}`)).toEqual({ block: true, reason: STOP_REASON });
    expect(await bash("git status")).toBeUndefined();
  });

  it("names PI_SPORE_SERVER_PID when it is missing or not a positive integer", () => {
    expect(() => bridgeEnv({ PI_SPORE_URL: "http://x", PI_SPORE_TOKEN: "t" })).toThrow(
      "PI_SPORE_SERVER_PID",
    );
    expect(() =>
      bridgeEnv({ PI_SPORE_URL: "http://x", PI_SPORE_TOKEN: "t", PI_SPORE_SERVER_PID: "-3" }),
    ).toThrow('PI_SPORE_SERVER_PID must be a positive integer, not "-3"');
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

  it("sends the recommended choice index in the question body", async () => {
    reply("POST /api/bridge/questions", { status: 201, body: { question: { id: "q1" } } });
    await fakePi()
      .tool("request_human_input")
      .execute("toolu_1", { question: "Which color?", choices: ["red", "blue"], recommended: 1 });

    expect(seen[0]?.body).toEqual({
      question: "Which color?",
      choices: ["red", "blue"],
      recommended: 1,
    });
  });

  it("sends the steps of a multi-step question, and no question of its own", async () => {
    reply("POST /api/bridge/questions", { status: 201, body: { question: { id: "q1" } } });
    const steps = [
      {
        type: "select",
        prompt: "Which palette?",
        options: [
          { label: "Dark", description: "Easier on the eyes", preview: "```css\n--bg: #111;\n```" },
          { label: "Light" },
        ],
        recommended: 0,
        allowOther: true,
      },
      { type: "confirm", prompt: "Ship it today?", recommended: true },
    ];
    await fakePi().tool("request_human_input").execute("toolu_1", { steps });

    expect(seen[0]?.body).toEqual({ steps });
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

  it("starts a background run, returns at once, and does not read the log", async () => {
    reply("POST /api/bridge/runs", { status: 201, body: run("running", { action: "dev" }) });

    const result = await fakePi()
      .tool("run_action")
      .execute("toolu_6", { name: "dev", background: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/api/bridge/runs",
      receipt: "toolu_6",
      body: { action: "dev" },
    });
    expect(result.content[0]?.text).toContain("run r1");
    expect(result.content[0]?.text).toContain("/logs/r1.log");
    expect(result.content[0]?.text).toContain("stop_action");
    expect(result.details).toEqual({ runId: "r1", status: "running" });
  });

  it("stops a run with the tool call id as receipt", async () => {
    reply("POST /api/bridge/runs/r1/cancel", { body: run("cancelled", { action: "dev" }) });

    const result = await fakePi().tool("stop_action").execute("toolu_7", { runId: "r1" });

    expect(seen).toEqual([
      {
        method: "POST",
        path: "/api/bridge/runs/r1/cancel",
        auth: "Bearer agent-token",
        receipt: "toolu_7",
        body: {},
      },
    ]);
    expect(result.content[0]?.text).toBe('Run r1 of action "dev" is cancelled.');
    expect(result.details).toEqual({ runId: "r1", status: "cancelled" });
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

  const artifact = (extra: Record<string, unknown> = {}) => ({
    scope: "workspace",
    ownerId: "w1",
    path: "plans/a.md",
    bytes: 12,
    updatedAt: 1,
    ...extra,
  });

  it("writes an artifact with the tool call id as receipt", async () => {
    reply("POST /api/bridge/artifacts", { body: { artifact: artifact() } });
    const result = await fakePi()
      .tool("artifacts_write")
      .execute("toolu_a1", { scope: "workspace", path: "plans/a.md", content: "# Plan" });
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/api/bridge/artifacts",
        auth: "Bearer agent-token",
        receipt: "toolu_a1",
        body: { scope: "workspace", path: "plans/a.md", content: "# Plan" },
      },
    ]);
    expect(result.content[0]?.text).toBe("Wrote workspace  plans/a.md  12 bytes");
  });

  it("lists the artifacts of both scopes, one line each", async () => {
    reply("GET /api/bridge/artifacts", {
      body: {
        workspace: [artifact()],
        project: [artifact({ scope: "project", path: "notes.md", bytes: 3, promotedFrom: "w1" })],
      },
    });
    const result = await fakePi().tool("artifacts_list").execute("toolu_a2", {});
    expect(result.content[0]?.text).toBe(
      [
        "workspace  plans/a.md  12 bytes",
        "project  notes.md  3 bytes  promoted from workspace w1",
      ].join("\n"),
    );
  });

  it("reads an artifact by scope and path", async () => {
    reply("GET /api/bridge/artifacts/file", { body: { artifact: artifact(), content: "# Plan" } });
    const result = await fakePi()
      .tool("artifacts_read")
      .execute("toolu_a3", { scope: "workspace", path: "plans/a.md" });
    expect(seen[0]?.path).toBe("/api/bridge/artifacts/file?scope=workspace&path=plans%2Fa.md");
    expect(result.content[0]?.text).toBe("# Plan");
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

  it("asks for a new run, with an optional base, and refuses a run mixed with a workspace target", async () => {
    reply("POST /api/bridge/cards/c1/start", {
      status: 201,
      body: { approval: { id: "a3", title: "x" } },
    });
    const pi = fakePi();
    await pi
      .tool("kanban_start_card")
      .execute("toolu_k6", { cardId: "c1", run: true, base: "develop", reason: "Big" });
    expect(seen[0]?.body).toEqual({ target: { kind: "run", base: "develop" }, reason: "Big" });
    await pi
      .tool("kanban_start_card")
      .execute("toolu_k7", { cardId: "c1", run: true, reason: "Big" });
    expect(seen[1]?.body).toEqual({ target: { kind: "run" }, reason: "Big" });
    for (const mixed of [{ workspaceId: "w2" }, { isolation: "new" }, { line: "feature" }]) {
      await expect(
        pi
          .tool("kanban_start_card")
          .execute("toolu_k8", { cardId: "c1", run: true, reason: "x", ...mixed }),
      ).rejects.toThrow("not both");
    }
    expect(seen).toHaveLength(2);
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
    expect(rules).toContain("before the first run");
    expect(rules).toContain("One pipeline run per workspace at a time");
    expect(rules).toContain("After three runs without success");
    expect(rules).toContain("Never stop the pi-spore server");
    expect(rules).toContain("`async: true`, never `async: false`");
    expect(rules).toContain("request_human_input");
    expect(rules).toContain("Never merge into the base branch on your own");
    expect(rules).toContain("Merge a PR only when the user asks");
    expect(rules).not.toContain("the worker of one workspace");
  });

  it("has the orchestrator pick light or default per slice and name it in the plan", () => {
    expect(RULES).toContain("Pick a pipeline for each slice.");
    expect(RULES).toContain("as `name`");
    expect(RULES).toContain("Use `light` for a small, clear slice");
    expect(RULES).toContain("Use `default` for a new feature");
    expect(RULES).toContain("Name the pipeline of each slice in the plan");
    expect(RULES).toContain("Pass it as `pipeline` to start_pipeline");
    expect(RULES).not.toContain("unless the plan names another");
  });

  it("tells the orchestrator to ask related decisions in one call with steps", () => {
    expect(RULES).toContain("Ask related decisions in one request_human_input call with steps");
  });

  it("tells a run coordinator to ask related decisions in one call with steps", () => {
    expect(COORDINATOR_RULES).toContain(
      "Ask related decisions in one request_human_input call with steps",
    );
  });

  it("names request_human_input in the guideline that teaches steps", () => {
    const guidelines = fakePi().tool("request_human_input").promptGuidelines ?? [];
    const aboutSteps = guidelines.find((line) => line.includes("with steps")) ?? "";
    expect(aboutSteps).toContain("request_human_input");
  });

  it("gives a side chat the side chat rules", async () => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", "side");
    const options = { contextFiles: [], sections: {} as Record<string, string> };
    await fakePi().handlers.get("before_agent_start")?.({ systemPromptOptions: options }, {});
    expect(options.sections[RULES_SECTION]).toBe(SIDE_RULES);
    expect(SIDE_RULES).toContain("next to the orchestrator");
    expect(SIDE_RULES).toContain("read-only");
  });

  it.each([
    ["worker", STAGE_WORKER_RULES, "implement worker"],
    ["reviewer", STAGE_REVIEWER_RULES, "read-only reviewer"],
    ["adversarial-reviewer", STAGE_REVIEWER_RULES, "read-only reviewer"],
  ])("gives a %s stage agent its stage rules", async (role, rules, phrase) => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", role);
    const options = { contextFiles: [], sections: {} as Record<string, string> };
    await fakePi().handlers.get("before_agent_start")?.({ systemPromptOptions: options }, {});
    expect(options.sections[RULES_SECTION]).toBe(rules);
    expect(rules).toContain(phrase);
  });

  it("tells the implement worker never to stop the pi-spore server", () => {
    expect(STAGE_WORKER_RULES).toContain("Never stop the pi-spore server");
  });

  it("tells the implement worker to run check and the full test action before every report", () => {
    expect(STAGE_WORKER_RULES).toMatch(
      /Before every `report`[^\n]*run `check`, then `run_action test`/,
    );
  });

  it.each([
    ["missing", undefined],
    ["unknown", "orchestrator"],
  ])("turns the tools off for a stage agent with a %s stage role", (_name, role) => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    if (role) vi.stubEnv("PI_SPORE_STAGE_ROLE", role);
    expect(fakePi().tools.size).toBe(0);
  });

  it("names PI_SPORE_STAGE_ROLE when a stage has no valid role", () => {
    expect(() =>
      bridgeEnv({
        PI_SPORE_URL: "http://x",
        PI_SPORE_TOKEN: "t",
        PI_SPORE_SERVER_PID: "1",
        PI_SPORE_CHAT_KIND: "stage",
      }),
    ).toThrow("PI_SPORE_STAGE_ROLE");
    expect(() =>
      bridgeEnv({
        PI_SPORE_URL: "http://x",
        PI_SPORE_TOKEN: "t",
        PI_SPORE_SERVER_PID: "1",
        PI_SPORE_CHAT_KIND: "stage",
        PI_SPORE_STAGE_ROLE: "boss",
      }),
    ).toThrow('"boss"');
    expect(
      bridgeEnv({
        PI_SPORE_URL: "http://x/",
        PI_SPORE_TOKEN: "t",
        PI_SPORE_SERVER_PID: "1",
        PI_SPORE_CHAT_KIND: "stage",
        PI_SPORE_STAGE_ROLE: "reviewer",
      }),
    ).toEqual({
      url: "http://x",
      token: "t",
      serverPid: 1,
      chatKind: "stage",
      stageRole: "reviewer",
    });
  });

  it("refuses an unknown chat kind instead of guessing", () => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", "reviewer");
    const pi = fakePi();
    expect(pi.tools.size).toBe(0);
  });
});

describe("spore-bridge report tool", () => {
  const JEV = "openrouter/~typesafe/jev-latest";
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-spore-bridge-"));
    vi.stubEnv("PI_SPORE_HOME", home);
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "reviewer");
    reply("POST /api/bridge/reports", { body: { turn: { id: "t1" } } });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** An extension context whose classifier answers `classify`; `calls` records what it was asked. */
  function context(classify: () => unknown, options: { classifier?: boolean } = {}) {
    const calls: { context: unknown; options: unknown }[] = [];
    const ctx = {
      modelRegistry: {
        findOfType: (_type: string, provider: string, id: string) =>
          options.classifier === false || `${provider}/${id}` !== JEV
            ? undefined
            : { provider, id, api: "typesafe-system-one" },
        classify: async (_model: unknown, askedContext: unknown, askedOptions: unknown) => {
          calls.push({ context: askedContext, options: askedOptions });
          return classify();
        },
      },
    };
    return { ctx, calls };
  }

  /** What Jev answers when it gives `stop` this probability. */
  const jev = (stop: number) => () => ({
    stopReason: "stop",
    answers: {
      another_round: {
        type: "choice",
        choice: stop >= 0.5 ? "stop" : "continue",
        probabilities: { stop, continue: 1 - stop },
      },
    },
  });

  const sentEarlyStop = () => ((seen[0] as Seen).body as { earlyStop?: unknown }).earlyStop;

  const minor = [{ severity: "minor", title: "Naming" }];
  const revise = { turn: "t1", summary: "Two nits", verdict: "revise", findings: minor };

  it.each(["worker", "side"])("is not registered for a %s chat", (kind) => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", kind);
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "");
    expect(fakePi().tools.has("report")).toBe(false);
  });

  it.each(["worker", "reviewer", "adversarial-reviewer"])(
    "is registered for a %s stage agent",
    (role) => {
      vi.stubEnv("PI_SPORE_STAGE_ROLE", role);
      expect(fakePi().tools.has("report")).toBe(true);
    },
  );

  it("sends a worker report with the receipt, no earlyStop, and ends the turn", async () => {
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "worker");
    const { ctx, calls } = context(jev(0.99));
    const report = {
      turn: "t1",
      summary: "Done",
      tests: [{ name: "adds", proof: "proofs/adds.txt" }],
    };
    const result = await fakePi()
      .tool("report")
      .execute("toolu_9", report, undefined, undefined, ctx);

    expect(calls).toHaveLength(0);
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/api/bridge/reports",
        auth: "Bearer agent-token",
        receipt: "toolu_9",
        body: report,
      },
    ]);
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ turn: "t1" });
    expect(result.content[0]?.text).toContain("turn t1");
  });

  it("asks Jev once for a REVISE with only minor findings and sends stop when P(stop) is high", async () => {
    const { ctx, calls } = context(jev(0.9));
    await fakePi().tool("report").execute("toolu_1", revise, undefined, undefined, ctx);

    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.context)).toContain("Two nits");
    expect(JSON.stringify(calls[0]?.context)).toContain("minor: Naming");
    expect(sentEarlyStop()).toEqual({
      stop: true,
      probability: 0.9,
    });
  });

  it("sends stop false when P(stop) is low", async () => {
    const { ctx, calls } = context(jev(0.3));
    const findings = [...minor, { severity: "important", title: "Edge case" }];
    await fakePi()
      .tool("report")
      .execute("toolu_1", { ...revise, findings }, undefined, undefined, ctx);

    expect(calls).toHaveLength(1);
    expect(sentEarlyStop()).toEqual({
      stop: false,
      probability: 0.3,
    });
  });

  it("does not stop below the threshold", async () => {
    const { ctx } = context(jev(0.69));
    await fakePi().tool("report").execute("toolu_1", revise, undefined, undefined, ctx);
    expect(sentEarlyStop()).toMatchObject({ stop: false });
  });

  it("skips Jev and earlyStop when a finding is blocking", async () => {
    const { ctx, calls } = context(jev(0.99));
    const findings = [...minor, { severity: "blocking", title: "Data loss" }];
    await fakePi()
      .tool("report")
      .execute("toolu_1", { ...revise, findings }, undefined, undefined, ctx);

    expect(calls).toHaveLength(0);
    expect(seen[0]?.body).not.toHaveProperty("earlyStop");
  });

  it("skips Jev for an APPROVE", async () => {
    const { ctx, calls } = context(jev(0.99));
    await fakePi()
      .tool("report")
      .execute(
        "toolu_1",
        { turn: "t1", summary: "Fine", verdict: "approve" },
        undefined,
        undefined,
        ctx,
      );

    expect(calls).toHaveLength(0);
    expect(seen[0]?.body).not.toHaveProperty("earlyStop");
  });

  it("skips Jev for an APPROVE that lists minor findings", async () => {
    const { ctx, calls } = context(jev(0.99));
    await fakePi()
      .tool("report")
      .execute("toolu_1", { ...revise, verdict: "approve" }, undefined, undefined, ctx);

    expect(calls).toHaveLength(0);
    expect(seen[0]?.body).not.toHaveProperty("earlyStop");
  });

  it("skips Jev for a worker, whatever the report says", async () => {
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "worker");
    const { ctx, calls } = context(jev(0.99));
    await fakePi().tool("report").execute("toolu_1", revise, undefined, undefined, ctx);

    expect(calls).toHaveLength(0);
    expect(seen[0]?.body).not.toHaveProperty("earlyStop");
  });

  it("skips Jev for a REVISE with no findings", async () => {
    const { ctx, calls } = context(jev(0.99));
    await fakePi()
      .tool("report")
      .execute(
        "toolu_1",
        { turn: "t1", summary: "Hm", verdict: "revise" },
        undefined,
        undefined,
        ctx,
      );

    expect(calls).toHaveLength(0);
    expect(seen[0]?.body).not.toHaveProperty("earlyStop");
  });

  it("asks Jev for an adversarial reviewer too", async () => {
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "adversarial-reviewer");
    const { ctx, calls } = context(jev(0.9));
    await fakePi().tool("report").execute("toolu_1", revise, undefined, undefined, ctx);
    expect(calls).toHaveLength(1);
  });

  it("sends stop false with the error when the classifier fails, and still reports", async () => {
    const { ctx } = context(() => ({ stopReason: "error", errorMessage: "quota" }));
    const result = await fakePi()
      .tool("report")
      .execute("toolu_1", revise, undefined, undefined, ctx);

    expect(sentEarlyStop()).toEqual({
      stop: false,
      error: "classifier failed (error): quota",
    });
    expect(result.terminate).toBe(true);
  });

  it("sends stop false with the error when the answer is malformed", async () => {
    const { ctx } = context(() => ({ stopReason: "stop", answers: {} }));
    await fakePi().tool("report").execute("toolu_1", revise, undefined, undefined, ctx);
    expect(sentEarlyStop()).toEqual({
      stop: false,
      error: 'classifier gave no usable answer to "another_round"',
    });
  });

  it("sends stop false with the error when the classifier is not in the catalog", async () => {
    const { ctx, calls } = context(jev(0.99), { classifier: false });
    await fakePi().tool("report").execute("toolu_1", revise, undefined, undefined, ctx);

    expect(calls).toHaveLength(0);
    expect(sentEarlyStop()).toEqual({
      stop: false,
      error: `classifier ${JEV} is not in the catalog`,
    });
  });

  it("rethrows an abort instead of reporting", async () => {
    const controller = new AbortController();
    const { ctx } = context(() => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(
      fakePi().tool("report").execute("toolu_1", revise, controller.signal, undefined, ctx),
    ).rejects.toThrow(/^aborted$/);
    expect(seen).toHaveLength(0);
  });

  it("turns a server refusal into a tool error that quotes the server", async () => {
    reply("POST /api/bridge/reports", {
      status: 409,
      body: { error: { code: "stale_turn", message: "Turn t0 is not open" } },
    });
    const { ctx } = context(jev(0.9));
    await expect(
      fakePi().tool("report").execute("toolu_1", revise, undefined, undefined, ctx),
    ).rejects.toThrow("Turn t0 is not open");
  });
});

describe("spore-bridge run tools", () => {
  const RUN_TOOLS = ["start_lane", "revise_lane", "merge_lane", "answer_lane", "open_run_pr"];
  const rulesOf = async (pi: ReturnType<typeof fakePi>) => {
    const options = { contextFiles: [], sections: {} as Record<string, string> };
    await pi.handlers.get("before_agent_start")?.({ systemPromptOptions: options }, {});
    return options.sections[RULES_SECTION];
  };

  it("gives the coordinator the five run tools, request_human_input, and the coordinator rules", async () => {
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    const pi = fakePi();

    for (const name of RUN_TOOLS) expect(pi.tools.has(name)).toBe(true);
    expect(pi.tools.has("request_human_input")).toBe(true);
    expect(pi.tools.has("ask_coordinator")).toBe(false);
    expect(await rulesOf(pi)).toBe(COORDINATOR_RULES);
    expect(COORDINATOR_RULES).toContain("never edit files or run commands");
    expect(COORDINATOR_RULES).toContain("answer_lane");
    expect(COORDINATOR_RULES).toContain("open_run_pr");
  });

  it("gives the coordinator kanban_list_cards and kanban_add_card, never update or start (ADR 0154)", async () => {
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    const pi = fakePi();

    expect(pi.tools.has("kanban_list_cards")).toBe(true);
    expect(pi.tools.has("kanban_add_card")).toBe(true);
    expect(pi.tools.has("kanban_update_card")).toBe(false);
    expect(pi.tools.has("kanban_start_card")).toBe(false);
    expect(COORDINATOR_RULES).toContain("kanban_list_cards");
    expect(COORDINATOR_RULES).toContain("kanban_add_card");
    expect(COORDINATOR_RULES).toContain("never start a card");
  });

  it("keeps all four card tools for an agent outside a run and for a lane agent", () => {
    const CARD_TOOLS = [
      "kanban_list_cards",
      "kanban_add_card",
      "kanban_update_card",
      "kanban_start_card",
    ];
    for (const name of CARD_TOOLS) expect(fakePi().tools.has(name)).toBe(true);
    vi.stubEnv("PI_SPORE_RUN_ROLE", "lane");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    for (const name of CARD_TOOLS) expect(fakePi().tools.has(name)).toBe(true);
  });

  it("sends each run tool to its route with the tool call id as receipt, and ends no turn", async () => {
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    const lane = (state: string) => ({ body: { lane: { id: "l1", name: "api", state } } });
    reply("POST /api/bridge/lanes", { status: 201, ...lane("waiting") });
    reply("POST /api/bridge/lanes/revise", lane("starting"));
    reply("POST /api/bridge/lanes/merge", lane("merging"));
    reply("POST /api/bridge/coordinator/answers", { body: { question: { id: "q1" } } });
    const pi = fakePi();

    const start = await pi
      .tool("start_lane")
      .execute("t1", { name: "api", brief: "briefs/api.md", wave: 1 });
    const revise = await pi
      .tool("revise_lane")
      .execute("t2", { laneId: "l1", brief: "briefs/api2.md" });
    const merge = await pi.tool("merge_lane").execute("t3", { laneId: "l1" });
    const answer = await pi
      .tool("answer_lane")
      .execute("t4", { questionId: "q1", answer: "sha256" });

    expect(seen.map((entry) => [entry.path, entry.receipt, entry.body])).toEqual([
      ["/api/bridge/lanes", "t1", { name: "api", brief: "briefs/api.md", wave: 1 }],
      ["/api/bridge/lanes/revise", "t2", { laneId: "l1", brief: "briefs/api2.md" }],
      ["/api/bridge/lanes/merge", "t3", { laneId: "l1" }],
      ["/api/bridge/coordinator/answers", "t4", { questionId: "q1", answer: "sha256" }],
    ]);
    expect(start.content[0]?.text).toBe('Lane "api" (l1) was added; it is waiting.');
    expect(revise.content[0]?.text).toContain("it is starting");
    expect(merge.content[0]?.text).toContain("The result arrives later as a message.");
    expect(answer.content[0]?.text).toContain("question q1");
    for (const result of [start, revise, merge, answer]) expect(result.terminate).toBeUndefined();
  });

  it("posts open_run_pr to coordinator/pr with the receipt and ends the turn", async () => {
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    reply("POST /api/bridge/coordinator/pr", {
      status: 201,
      body: { approval: { id: "a1", title: 'Open the PR of run "api"' } },
    });

    const result = await fakePi()
      .tool("open_run_pr")
      .execute("t5", { title: "Ship the API", body: "Two lanes merged." });

    expect(seen.map((entry) => [entry.path, entry.receipt, entry.body])).toEqual([
      ["/api/bridge/coordinator/pr", "t5", { title: "Ship the API", body: "Two lanes merged." }],
    ]);
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toContain("approval a1");
  });

  it("posts open_pr to workspace/pr with the receipt and ends the turn", async () => {
    reply("POST /api/bridge/workspace/pr", {
      status: 201,
      body: { approval: { id: "a2", title: "Open the PR of this workspace" } },
    });

    const result = await fakePi()
      .tool("open_pr")
      .execute("t6", { title: "Add the thing", body: "Changed X. Tested Y." });

    expect(seen.map((entry) => [entry.path, entry.receipt, entry.body])).toEqual([
      ["/api/bridge/workspace/pr", "t6", { title: "Add the thing", body: "Changed X. Tested Y." }],
    ]);
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toContain("approval a2");
  });

  it("gives open_pr to the orchestrator chat only", () => {
    expect(fakePi().tools.has("open_pr")).toBe(true);

    vi.stubEnv("PI_SPORE_CHAT_KIND", "side");
    expect(fakePi().tools.has("open_pr")).toBe(false);
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "worker");
    expect(fakePi().tools.has("open_pr")).toBe(false);
    vi.stubEnv("PI_SPORE_CHAT_KIND", "worker");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
    expect(fakePi().tools.has("open_pr")).toBe(false);
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "worker");
    vi.stubEnv("PI_SPORE_RUN_ROLE", "lane");
    expect(fakePi().tools.has("open_pr")).toBe(false);
  });

  it("names open_pr and push_line in the orchestrator rules, not the coordinator rules", () => {
    expect(RULES).toContain("`open_pr`");
    expect(RULES).toContain("`push_line`");
    expect(COORDINATOR_RULES).not.toContain("open_pr");
    expect(COORDINATOR_RULES).not.toContain("push_line");
  });

  it("posts push_line to workspace/push with the receipt and does not end the turn", async () => {
    reply("POST /api/bridge/workspace/push", {
      status: 200,
      body: { remote: "origin", line: "spore/feature" },
    });

    const result = await fakePi().tool("push_line").execute("t7", {});

    expect(seen.map((entry) => [entry.path, entry.receipt, entry.body])).toEqual([
      ["/api/bridge/workspace/push", "t7", {}],
    ]);
    expect(result.terminate).toBeUndefined();
    expect(result.content[0]?.text).toBe("Pushed spore/feature to origin.");
  });

  it("gives push_line to the orchestrator chat only", () => {
    expect(fakePi().tools.has("push_line")).toBe(true);

    vi.stubEnv("PI_SPORE_CHAT_KIND", "side");
    expect(fakePi().tools.has("push_line")).toBe(false);
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "worker");
    expect(fakePi().tools.has("push_line")).toBe(false);
    vi.stubEnv("PI_SPORE_CHAT_KIND", "worker");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
    expect(fakePi().tools.has("push_line")).toBe(false);
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "worker");
    vi.stubEnv("PI_SPORE_RUN_ROLE", "lane");
    expect(fakePi().tools.has("push_line")).toBe(false);
  });

  it("gives a lane stage agent ask_coordinator, not request_human_input, and the lane paragraph", async () => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "worker");
    vi.stubEnv("PI_SPORE_RUN_ROLE", "lane");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    reply("POST /api/bridge/coordinator/questions", {
      status: 201,
      body: { question: { id: "q1" } },
    });
    const pi = fakePi();

    expect(pi.tools.has("request_human_input")).toBe(false);
    for (const name of RUN_TOOLS) expect(pi.tools.has(name)).toBe(false);
    const result = await pi.tool("ask_coordinator").execute("t1", { question: "Which hash?" });
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/api/bridge/coordinator/questions",
        auth: "Bearer agent-token",
        receipt: "t1",
        body: { question: "Which hash?" },
      },
    ]);
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toContain("question q1");
    expect(await rulesOf(pi)).toBe(`${STAGE_WORKER_RULES}\n\n${LANE_RULES}`);
    expect(LANE_RULES).toContain("never the user");
  });

  // Pi runs a whole message's tool calls one by one, in order, when one of them is sequential. So a brief
  // written by artifacts_write in the same message exists before the brief tool reads it.
  it("registers the tools that read a brief as sequential", () => {
    expect(fakePi().tool("start_pipeline").executionMode).toBe("sequential");
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
    vi.stubEnv("PI_SPORE_RUN_ID", "U1");
    const coordinator = fakePi();
    expect(coordinator.tool("start_lane").executionMode).toBe("sequential");
    expect(coordinator.tool("revise_lane").executionMode).toBe("sequential");
  });

  // "A later message" read as the user's next message, so the chat ended its turn after each brief and waited.
  it("tells the orchestrator and coordinator to call a brief tool in the next step of the same turn", () => {
    const oneLine = (rules: string) => rules.replace(/\s+/g, " ");
    expect(oneLine(RULES)).toContain(
      "wait for its result. Then call start_pipeline with its path in your next step, after that result, in the same turn. Do not end your turn between them. The plan's yes covers it.",
    );
    expect(oneLine(COORDINATOR_RULES)).toContain(
      "wait for its result. Then call start_lane or revise_lane in your next step, after that result, in the same turn. Do not end your turn between them.",
    );
    expect(oneLine(RULES)).not.toContain("later message");
    expect(oneLine(COORDINATOR_RULES)).not.toContain("later message");
  });

  // A plain-text stop puts nothing on Home, so the user does not know the chat waits.
  it("tells the orchestrator and coordinator to wait for the user only through request_human_input", () => {
    const oneLine = (rules: string) => rules.replace(/\s+/g, " ");
    const rule =
      "Never end a turn to wait for the user without request_human_input. A turn that ends with plain text puts nothing on Home.";
    expect(oneLine(RULES)).toContain(rule);
    expect(oneLine(COORDINATOR_RULES)).toContain(rule);
  });

  it("gives the orchestrator start_pipeline and the rules that use it", () => {
    expect(fakePi().tools.has("start_pipeline")).toBe(true);
    expect(RULES).toContain("start_pipeline");
    expect(RULES).toContain("Do not start `worker` subagents for feature code");
  });

  it("keeps start_pipeline from coordinators, lane agents, side chats, and stage chats", () => {
    const without = (env: Record<string, string>) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      expect(fakePi().tools.has("start_pipeline")).toBe(false);
      for (const key of Object.keys(env)) vi.stubEnv(key, undefined);
    };
    without({ PI_SPORE_RUN_ROLE: "coordinator", PI_SPORE_RUN_ID: "U1" });
    without({ PI_SPORE_RUN_ROLE: "lane", PI_SPORE_RUN_ID: "U1" });
    without({ PI_SPORE_CHAT_KIND: "side" });
    without({ PI_SPORE_CHAT_KIND: "stage", PI_SPORE_STAGE_ROLE: "worker" });
  });

  it("posts start_pipeline with the tool call id as receipt and ends the turn", async () => {
    reply("POST /api/bridge/pipelines", {
      status: 201,
      body: { run: { id: "pr1", pipelineId: "default", state: "running" } },
    });
    const pi = fakePi();

    expect(pi.tool("start_pipeline").parameters?.properties).toHaveProperty("name");
    const first = await pi.tool("start_pipeline").execute("t1", { brief: "briefs/a.md" });
    await pi.tool("start_pipeline").execute("t1", { brief: "briefs/a.md" });
    await pi.tool("start_pipeline").execute("t2", { brief: "briefs/a.md", pipeline: "p" });
    await pi.tool("start_pipeline").execute("t3", { brief: "briefs/a.md", name: "push_line tool" });

    expect(seen.map((entry) => [entry.path, entry.receipt, entry.body])).toEqual([
      ["/api/bridge/pipelines", "t1", { brief: "briefs/a.md" }],
      ["/api/bridge/pipelines", "t1", { brief: "briefs/a.md" }],
      ["/api/bridge/pipelines", "t2", { brief: "briefs/a.md", pipeline: "p" }],
      ["/api/bridge/pipelines", "t3", { brief: "briefs/a.md", name: "push_line tool" }],
    ]);
    expect(first.content[0]?.text).toContain("Pipeline run pr1");
    expect(first.content[0]?.text).toContain("do not poll");
    expect(first.details).toEqual({ runId: "pr1" });
    expect(first.terminate).toBe(true);
  });

  it("gives a plain worker neither the run tools nor ask_coordinator", async () => {
    const pi = fakePi();

    expect(pi.tools.has("request_human_input")).toBe(true);
    for (const name of [...RUN_TOOLS, "ask_coordinator"]) expect(pi.tools.has(name)).toBe(false);
    expect(await rulesOf(pi)).toBe(RULES);
  });

  it.each(["coordinator", "lane"])(
    "gives the %s run_status, which GETs the run's status",
    async (role) => {
      vi.stubEnv("PI_SPORE_RUN_ROLE", role);
      vi.stubEnv("PI_SPORE_RUN_ID", "U1");
      const status = {
        runId: "U1",
        name: "api",
        state: "running",
        lanes: [
          {
            id: "l1",
            name: "core",
            wave: 1,
            state: "running",
            workspace: "api core",
            stage: "gates",
            blocked: 'no action "check"',
          },
          { id: "l2", name: "docs", wave: 2, state: "waiting" },
        ],
      };
      reply("GET /api/bridge/run-status/U1", { body: { status } });

      const result = await fakePi().tool("run_status").execute("t1", {});

      expect(seen.map((entry) => [entry.method, entry.path])).toEqual([
        ["GET", "/api/bridge/run-status/U1"],
      ]);
      expect(result.content[0]?.text).toBe(
        [
          'Run "api" (U1) is running.',
          '- "core" (l1), wave 1, running, workspace "api core", stage gates, blocked: no action "check"',
          '- "docs" (l2), wave 2, waiting',
        ].join("\n"),
      );
      expect(result.details).toEqual(status);
      expect(COORDINATOR_RULES).toContain("Call run_status before you say a lane is lost or stuck");
    },
  );

  it("names PI_SPORE_RUN_ID when a run role has none", () => {
    expect(() =>
      bridgeEnv({
        PI_SPORE_URL: "http://x",
        PI_SPORE_TOKEN: "t",
        PI_SPORE_SERVER_PID: "1",
        PI_SPORE_RUN_ROLE: "lane",
      }),
    ).toThrow("PI_SPORE_RUN_ID is not set");
  });

  it("names PI_SPORE_RUN_ROLE when it is not coordinator or lane", () => {
    expect(() =>
      bridgeEnv({
        PI_SPORE_URL: "http://x",
        PI_SPORE_TOKEN: "t",
        PI_SPORE_SERVER_PID: "1",
        PI_SPORE_RUN_ROLE: "boss",
      }),
    ).toThrow('PI_SPORE_RUN_ROLE must be coordinator or lane, not "boss"');
    vi.stubEnv("PI_SPORE_RUN_ROLE", "boss");
    expect(fakePi().tools.size).toBe(0);
  });
});
