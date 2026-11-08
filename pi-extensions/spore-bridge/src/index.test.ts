import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeEnv } from "./client.js";
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
    expect(rules).toContain("Never merge into the base branch on your own");
    expect(rules).toContain("Merge a PR only when the user asks");
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
      bridgeEnv({ PI_SPORE_URL: "http://x", PI_SPORE_TOKEN: "t", PI_SPORE_CHAT_KIND: "stage" }),
    ).toThrow("PI_SPORE_STAGE_ROLE");
    expect(() =>
      bridgeEnv({
        PI_SPORE_URL: "http://x",
        PI_SPORE_TOKEN: "t",
        PI_SPORE_CHAT_KIND: "stage",
        PI_SPORE_STAGE_ROLE: "boss",
      }),
    ).toThrow('"boss"');
    expect(
      bridgeEnv({
        PI_SPORE_URL: "http://x/",
        PI_SPORE_TOKEN: "t",
        PI_SPORE_CHAT_KIND: "stage",
        PI_SPORE_STAGE_ROLE: "reviewer",
      }),
    ).toEqual({ url: "http://x", token: "t", chatKind: "stage", stageRole: "reviewer" });
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
  const RUN_TOOLS = ["start_lane", "revise_lane", "merge_lane", "answer_lane"];
  const rulesOf = async (pi: ReturnType<typeof fakePi>) => {
    const options = { contextFiles: [], sections: {} as Record<string, string> };
    await pi.handlers.get("before_agent_start")?.({ systemPromptOptions: options }, {});
    return options.sections[RULES_SECTION];
  };

  it("gives the coordinator the four run tools, request_human_input, and the coordinator rules", async () => {
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
    const pi = fakePi();

    for (const name of RUN_TOOLS) expect(pi.tools.has(name)).toBe(true);
    expect(pi.tools.has("request_human_input")).toBe(true);
    expect(pi.tools.has("ask_coordinator")).toBe(false);
    expect(await rulesOf(pi)).toBe(COORDINATOR_RULES);
    expect(COORDINATOR_RULES).toContain("never edit files or run commands");
    expect(COORDINATOR_RULES).toContain("answer_lane");
    expect(COORDINATOR_RULES).toContain("PR tab");
  });

  it("sends each run tool to its route with the tool call id as receipt, and ends no turn", async () => {
    vi.stubEnv("PI_SPORE_RUN_ROLE", "coordinator");
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

  it("gives a lane stage agent ask_coordinator, not request_human_input, and the lane paragraph", async () => {
    vi.stubEnv("PI_SPORE_CHAT_KIND", "stage");
    vi.stubEnv("PI_SPORE_STAGE_ROLE", "worker");
    vi.stubEnv("PI_SPORE_RUN_ROLE", "lane");
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

  it("gives a plain worker neither the run tools nor ask_coordinator", async () => {
    const pi = fakePi();

    expect(pi.tools.has("request_human_input")).toBe(true);
    for (const name of [...RUN_TOOLS, "ask_coordinator"]) expect(pi.tools.has(name)).toBe(false);
    expect(await rulesOf(pi)).toBe(RULES);
  });

  it("names PI_SPORE_RUN_ROLE when it is not coordinator or lane", () => {
    expect(() =>
      bridgeEnv({ PI_SPORE_URL: "http://x", PI_SPORE_TOKEN: "t", PI_SPORE_RUN_ROLE: "boss" }),
    ).toThrow('PI_SPORE_RUN_ROLE must be coordinator or lane, not "boss"');
    vi.stubEnv("PI_SPORE_RUN_ROLE", "boss");
    expect(fakePi().tools.size).toBe(0);
  });
});
