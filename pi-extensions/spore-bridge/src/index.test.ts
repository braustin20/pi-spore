import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sporeBridge from "./index.js";
import { RULES, RULES_SECTION } from "./rules.js";

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
});
