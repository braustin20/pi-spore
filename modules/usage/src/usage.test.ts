import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsModule } from "@pi-spore/mod-agents/server";
import { attentionModule, HomeItemsKey } from "@pi-spore/mod-attention/server";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { vcsFolderModule } from "@pi-spore/mod-vcs-folder/server";
import { vcsGitModule } from "@pi-spore/mod-vcs-git/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import type { ServerModule } from "@pi-spore/module-api";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import {
  CreateWorkspaceResponse,
  parse,
  RoutingDecisionsResponse,
  TokenUseResponse,
  UsagePlansResponse,
} from "@pi-spore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakePipelines } from "./fake-pipelines.js";
import { formatAge, formatTokens, formatUntil } from "./format.js";
import { createUsageModule, warningsFor } from "./server.js";

const START = 1_800_000_000_000;
const FAKE_PI = fileURLToPath(new URL("../../agents/test-fixtures/fake-pi.mjs", import.meta.url));
let server: TestServer;
let agents: ReturnType<typeof createAgentsModule>;
let scratch: string;
/** Pushes the inbox, as any other module's change would. */
let nudgeHome: () => void;

/** Another module that changes Home for its own reasons. */
const otherModule: ServerModule = {
  id: "other",
  requires: ["attention"],
  core: false,
  setup(host) {
    nudgeHome = host.use(HomeItemsKey).changed;
  },
};

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-spore-usage-mod-")));
  agents = createAgentsModule({
    pi: { command: process.execPath, args: [FAKE_PI] },
    resourceArgs: async () => ["--no-extensions"],
    roleDefaults: async () => ({}),
    baseEnv: { PATH: process.env.PATH },
    idleStopMs: 60_000,
    startTimeoutMs: 5_000,
  });
  server = await createTestServer(
    [
      fakePipelines().module,
      projectsModule,
      vcsGitModule,
      vcsFolderModule,
      workspacesModule,
      agents,
      attentionModule,
      createUsageModule(),
      otherModule,
    ],
    { startAt: START },
  );
});
afterEach(async () => {
  await agents.manager().stopAll();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function json(response: Response, status = 200): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** A Git project with one in-place workspace. */
async function workspace() {
  const repo = join(scratch, "game");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "game\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const { project } = (await json(
    await server.request("POST", "/api/projects", { path: repo, name: "Game" }),
    201,
  )) as { project: { id: string } };
  return parse(
    CreateWorkspaceResponse,
    await json(
      await server.request("POST", "/api/workspaces", {
        projectId: project.id,
        name: "Fix jump",
        isolation: "in-place",
      }),
      201,
    ),
    "create",
  ).workspace;
}

/** A session line for an assistant message with this usage. */
const assistant = (provider: string, model: string, input: number, output: number, cost = 0) =>
  JSON.stringify({
    type: "message",
    id: `${provider}-${input}`,
    message: {
      role: "assistant",
      provider,
      model,
      usage: { input, output, cacheRead: 10, cacheWrite: 0, cost: { total: cost } },
    },
  });

const writePlan = (plan: string, body: unknown) => {
  mkdirSync(join(server.paths.root, "usage"), { recursive: true });
  writeFileSync(join(server.paths.root, "usage", `${plan}.json`), JSON.stringify(body));
};

describe("Home items (ADR 0152, R18.4)", () => {
  const usageItems = async () =>
    (
      (await json(await server.request("GET", "/api/attention/inbox"))) as {
        items: { kind: string; source: string; id: string; title: string; href: string }[];
      }
    ).items.filter((item) => item.kind === "notice" && item.source === "usage");

  const claude = (weekly: number) =>
    writePlan("claude", {
      plan: "claude",
      source: "anthropic-ratelimit-unified headers",
      seenAt: START - 60_000,
      windows: { "7d": { utilization: weekly, seenAt: START - 60_000 } },
    });

  it("shows a usage warning on Home with a link to the Usage page, and drops it when the window clears", async () => {
    claude(0.5);
    expect(await usageItems()).toEqual([]);
    claude(0.8);
    expect(await usageItems()).toMatchObject([
      {
        id: "claude:7d",
        title: "Claude weekly window is at 80%, over the 75% threshold.",
        href: "#/usage",
      },
    ]);
    claude(0.5);
    expect(await usageItems()).toEqual([]);
  });
});

describe("Home items follow plan files live (ADR 0152, R18.4)", () => {
  const noticeTitles = () =>
    (
      server.events.eventsOf("attention:inbox") as {
        inbox: { items: { kind: string; title?: string }[] };
      }[]
    ).map((event) =>
      event.inbox.items.filter((item) => item.kind === "notice").map((item) => item.title),
    );
  const untilPushed = async (check: (pushed: (string | undefined)[][]) => boolean) => {
    for (let tries = 0; tries < 300; tries++) {
      if (check(noticeTitles())) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No matching inbox was pushed: ${JSON.stringify(noticeTitles())}`);
  };
  const claude = (weekly: number) =>
    writePlan("claude", {
      plan: "claude",
      source: "anthropic-ratelimit-unified headers",
      seenAt: START - 60_000,
      windows: { "7d": { utilization: weekly, seenAt: START - 60_000 } },
    });

  it("pushes the inbox when a plan file crosses a threshold and when it clears, with no other change", async () => {
    claude(0.8);
    await untilPushed((pushed) => pushed.some((titles) => titles.length === 1));
    claude(0.5);
    await untilPushed((pushed) => pushed.at(-1)?.length === 0 && pushed.length > 1);
  });

  it("shows a warning again when a fresh reading follows one that went stale", async () => {
    const maxAge = (minutes: number) =>
      writeFileSync(
        join(server.paths.root, "settings.json"),
        JSON.stringify({ router: { usageMaxAgeMinutes: minutes } }),
      );
    claude(0.8);
    await untilPushed((pushed) => pushed.some((titles) => titles.length === 1));
    // The reading ages out with no file change, and another module's change drops the warning from Home.
    maxAge(1);
    nudgeHome();
    await untilPushed((pushed) => pushed.at(-1)?.length === 0 && pushed.length > 1);
    // A fresh reading at the same percentage is a new warning.
    maxAge(60);
    claude(0.8);
    await untilPushed((pushed) => pushed.at(-1)?.length === 1 && pushed.length > 2);
  });
});

describe("GET /api/usage/plans", () => {
  it("shows each plan's windows with their age, marks stale ones, and warns over a threshold", async () => {
    writePlan("claude", {
      plan: "claude",
      status: "allowed",
      source: "anthropic-ratelimit-unified headers",
      seenAt: START - 60_000,
      windows: {
        "5h": { utilization: 0.4, resetsAt: START + 3_600_000, seenAt: START - 60_000 },
        "7d": { utilization: 0.8, resetsAt: START + 86_400_000, seenAt: START - 60_000 },
      },
    });
    writePlan("codex", {
      plan: "codex",
      source: "x-codex headers",
      seenAt: START - 7_200_000,
      windows: { "7d": { utilization: 1, seenAt: START - 7_200_000 } },
    });

    const body = parse(
      UsagePlansResponse,
      await json(await server.request("GET", "/api/usage/plans")),
      "plans",
    );
    expect(body.plans.map((plan) => plan.plan)).toEqual(["claude", "codex"]);
    const [claude, codex] = body.plans;
    expect(claude?.windows.map((window) => [window.name, window.stale])).toEqual([
      ["5h", undefined],
      ["7d", undefined],
    ]);
    expect(claude?.ageMs).toBeGreaterThanOrEqual(60_000);
    expect(codex?.windows[0]?.stale).toMatch(/^seen 120 min ago$/);
    // Codex is full but stale, so only Claude's weekly window warns.
    expect(body.warnings).toEqual([
      {
        plan: "claude",
        window: "7d",
        utilization: 0.8,
        message: "Claude weekly window is at 80%, over the 75% threshold.",
      },
    ]);
    expect(body.thresholds).toEqual({ weekly: 0.75, fiveHour: 1 });
  });

  it("lists a broken plan file as an error instead of failing the page", async () => {
    writePlan("claude", { plan: "claude" });
    const body = parse(
      UsagePlansResponse,
      await json(await server.request("GET", "/api/usage/plans")),
      "plans",
    );
    expect(body.plans).toEqual([]);
    expect(body.errors[0]).toMatch(/claude\.json/);
  });

  it("answers 422 when the router settings are wrong", async () => {
    writeFileSync(
      join(server.paths.root, "settings.json"),
      JSON.stringify({ router: { pressure: { weekly: 3 } } }),
    );
    const body = (await json(await server.request("GET", "/api/usage/plans"), 422)) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("bad_settings");
  });
});

describe("GET /api/usage/tokens", () => {
  it("sums token use per workspace and model, and shows local models as free", async () => {
    const ws = await workspace();
    const dir = join(server.paths.sessions, ws.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "a.jsonl"),
      [
        JSON.stringify({ type: "session", cwd: "/x" }),
        assistant("claude-bridge", "claude-sonnet-5-5", 100, 20),
        assistant("claude-bridge", "claude-sonnet-5-5", 200, 30),
        assistant("strata", "qwen3.8-flash-next-unsloth-ud-iq2_xs", 1_000, 300, 0.5),
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
        '{"type":"mess',
      ].join("\n"),
    );
    writeFileSync(join(dir, "b.jsonl"), assistant("openai", "gpt-6.1-terra", 50, 5, 0.25));

    const body = parse(
      TokenUseResponse,
      await json(await server.request("GET", "/api/usage/tokens")),
      "tokens",
    );
    expect(body.sessions).toBe(2);
    expect(body.skippedLines).toBe(1);
    const byModel = Object.fromEntries(body.rows.map((row) => [row.model, row]));
    expect(byModel["claude-sonnet-5-5"]).toMatchObject({
      projectName: "Game",
      workspaceName: "Fix jump",
      requests: 2,
      input: 300,
      output: 50,
      cacheRead: 20,
      local: false,
    });
    expect(byModel["qwen3.8-flash-next-unsloth-ud-iq2_xs"]).toMatchObject({ local: true, cost: 0 });
    expect(byModel["gpt-6.1-terra"]).toMatchObject({ cost: 0.25, local: false });
  });

  it("counts a forked session's copied requests once, in its parent", async () => {
    const ws = await workspace();
    const dir = join(server.paths.sessions, ws.id);
    mkdirSync(dir, { recursive: true });
    const at = (time: string, line: string) =>
      JSON.stringify({ ...JSON.parse(line), timestamp: time });
    const copied = at(
      "2026-11-07T10:00:00.000Z",
      assistant("claude-bridge", "claude-sonnet-5-5", 100, 20),
    );
    writeFileSync(
      join(dir, "worker.jsonl"),
      [
        JSON.stringify({ type: "session", cwd: "/x", timestamp: "2026-11-07T09:00:00.000Z" }),
        copied,
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "side.jsonl"),
      [
        JSON.stringify({
          type: "session",
          cwd: "/x",
          timestamp: "2026-11-07T11:00:00.000Z",
          parentSession: join(dir, "worker.jsonl"),
        }),
        copied,
        at("2026-11-07T11:05:00.000Z", assistant("claude-bridge", "claude-sonnet-5-5", 7, 3)),
      ].join("\n"),
    );
    const body = parse(
      TokenUseResponse,
      await json(await server.request("GET", "/api/usage/tokens")),
      "tokens",
    );
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ requests: 2, input: 107, output: 23 });
  });

  it("names sessions of workspaces it does not know", async () => {
    mkdirSync(join(server.paths.sessions, "gone"), { recursive: true });
    writeFileSync(join(server.paths.sessions, "gone", "a.jsonl"), assistant("x", "y", 1, 1));
    const body = parse(
      TokenUseResponse,
      await json(await server.request("GET", "/api/usage/tokens")),
      "tokens",
    );
    expect(body.rows[0]).toMatchObject({
      workspaceId: "gone",
      workspaceName: "(removed workspace)",
      projectName: "(unknown)",
    });
  });
});

describe("GET /api/usage/routing", () => {
  it("returns the newest decisions first and counts lines that do not parse", async () => {
    mkdirSync(join(server.paths.root, "usage"), { recursive: true });
    const record = (at: number, route: string) =>
      JSON.stringify({ at, kind: "initial", route, model: "m/x", reasons: ["r"] });
    writeFileSync(
      join(server.paths.root, "usage", "routing.jsonl"),
      `${record(1, "cloud")}\n{broken\n${record(2, "local")}\n`,
    );
    const body = parse(
      RoutingDecisionsResponse,
      await json(await server.request("GET", "/api/usage/routing?limit=5")),
      "routing",
    );
    expect(body.decisions.map((decision) => decision.route)).toEqual(["local", "cloud"]);
    expect(body.skipped).toBe(1);
    await json(await server.request("GET", "/api/usage/routing?limit=0"), 400);
  });
});

describe("warningsFor", () => {
  const pressure = { weekly: 0.75, fiveHour: 1 };
  it("warns on a full window and on a weekly window over its threshold, never on stale ones", () => {
    expect(
      warningsFor(
        "codex",
        [
          { name: "5h", utilization: 1 },
          { name: "7d", utilization: 0.75 },
          { name: "7d", utilization: 0.99, stale: "old" },
        ],
        pressure,
      ).map((warning) => warning.message),
    ).toEqual(["Codex 5-hour window is full (100%)."]);
  });
});

describe("format", () => {
  it("writes ages, resets, and token counts in short words", () => {
    expect(formatAge(30_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5 min ago");
    expect(formatUntil(10 + 90 * 60_000, 10)).toBe("in 1 h 30 min");
    expect(formatUntil(5, 10)).toBe("passed");
    expect(formatTokens(12_345)).toBe("12.3k");
  });
});
