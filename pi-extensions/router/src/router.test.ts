import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalLocks } from "./lock.js";
import { readRecords } from "./records.js";
import { NoRoomError, Router, type RouterDeps, type RouterState } from "./router.js";
import { fakeContext, GOOD, jevResult, SONNET, STRATA, userRequest } from "./test-fakes.js";
import { readPlan, writeReading } from "./usage.js";

let root: string;
let home: string;
let cwd: string;
let lockFolder: string;
const NOW = 1_794_000_000_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-spore-router-"));
  home = join(root, "home");
  cwd = join(root, "project");
  lockFolder = join(root, "run", "pi-spore");
  mkdirSync(home);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "math.ts"), "export const x = 1;\n");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ router: { cloud: SONNET } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Harness {
  router: Router;
  sleeps: number[];
  announced: string[];
  health: { ok: boolean };
}

function harness(
  overrides: Partial<RouterDeps> = {},
  pid = 100,
  alive = (p: number) => p === pid,
): Harness {
  const sleeps: number[] = [];
  const announced: string[] = [];
  const health = { ok: true };
  const locks = new LocalLocks(lockFolder, pid, alive);
  const router = new Router({
    home,
    env: { PI_SPORE_AGENT_ID: "agent-1", PI_SPORE_WORKSPACE_ID: "ws-1" },
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    locks: () => locks,
    healthy: async () => health.ok,
    announceLocal: (target) => {
      announced.push(`${target.provider}/${target.modelId}`);
      return [];
    },
    workerModel: async () => SONNET,
    isOverflow: (message) => message.errorMessage === "context_length_exceeded",
    ...overrides,
  });
  return { router, sleeps, announced, health };
}

const BRIEF = "In src/math.ts add clamp(value, min, max). Add a test. Run npm test.";

describe("Router: first request of a session", () => {
  it("routes a bounded task local, holds the slot, starts the target, and records why", async () => {
    const { router, announced } = harness();
    const { ctx, notices, classifyCalls } = fakeContext(cwd);

    const route = await router.route(userRequest(BRIEF), ctx);

    expect(`${route.model.provider}/${route.model.id}`).toBe(STRATA);
    expect(route.thinkingLevel).toBe("high");
    expect(route.state).toMatchObject({ route: "local", model: STRATA, failures: 0 });
    expect(classifyCalls).toHaveLength(1);
    expect(announced).toEqual([STRATA]);
    expect(notices[0]?.message).toMatch(/^spore\/auto: local → strata\//);

    const { records } = await readRecords(home, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "initial",
      route: "local",
      model: STRATA,
      agentId: "agent-1",
      workspaceId: "ws-1",
      sessionId: "session-1",
      budget: 65_536,
      jev: GOOD,
      threshold: 0.7,
      pressure: false,
    });
    expect(records[0]?.estimate).toBeGreaterThan(5);
    expect(records[0]?.usage).toEqual(["claude: no usage seen", "codex: no usage seen"]);
  });

  it("routes a visual task to the cloud model", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classify: () => jevResult({ ...GOOD, visual: 0.2 }) });
    const route = await router.route(userRequest("Make the menu screen look nicer"), ctx);
    expect(`${route.model.provider}/${route.model.id}`).toBe(SONNET);
    expect(route.state).toMatchObject({ route: "cloud", model: SONNET });
    const { records } = await readRecords(home, 1);
    expect(records[0]?.reasons).toContain("visual: nonvisual 0.20 < 0.7");
  });

  it("skips the classifier when the task does not fit the local budget", async () => {
    writeFileSync(join(cwd, "src", "big.ts"), "x".repeat(300_000));
    const { router } = harness();
    const { ctx, classifyCalls } = fakeContext(cwd);
    const route = await router.route(userRequest("Refactor src/big.ts"), ctx);
    expect(route.state?.route).toBe("cloud");
    expect(classifyCalls).toHaveLength(0);
  });

  it("counts the system prompt in the estimate", async () => {
    const { router } = harness();
    const { ctx, classifyCalls } = fakeContext(cwd, { systemPrompt: "s".repeat(280_000) });
    const route = await router.route(userRequest(BRIEF), ctx);
    expect(route.state?.route).toBe("cloud");
    expect(classifyCalls).toHaveLength(0);
    expect((await readRecords(home, 1)).records[0]?.estimate).toBeGreaterThan(70_000);
  });

  it("goes to cloud and records it when the classifier is missing", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classifier: false });
    const route = await router.route(userRequest(BRIEF), ctx);
    expect(route.state?.route).toBe("cloud");
    expect((await readRecords(home, 1)).records[0]?.reasons).toEqual([
      "classifier openrouter/~typesafe/jev-latest is not in the catalog",
    ]);
  });

  it("goes to cloud when the local target does not answer its health URL, and frees the slot", async () => {
    const first = harness();
    first.health.ok = false;
    const { ctx } = fakeContext(cwd);
    const route = await first.router.route(userRequest(BRIEF), ctx);
    expect(route.state?.route).toBe("cloud");
    expect((await readRecords(home, 1)).records[0]?.reasons).toContain(
      `local target not ready: ${STRATA} does not answer at http://127.0.0.1:8080/health`,
    );
    const other = new LocalLocks(lockFolder, 200, () => true);
    expect(await other.tryAcquire(STRATA, 1, "s2")).toBeDefined();
  });

  it("lowers the threshold under Claude usage pressure", async () => {
    await writeReading(
      home,
      { plan: "claude", source: "test", windows: { "7d": { utilization: 0.8 } } },
      NOW - 60_000,
    );
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classify: () => jevResult({ ...GOOD, explicit: 0.6 }) });
    const route = await router.route(userRequest(BRIEF), ctx);
    expect(route.state?.route).toBe("local");
    expect((await readRecords(home, 1)).records[0]).toMatchObject({
      pressure: true,
      threshold: 0.55,
    });
  });

  it("spills to Codex when Claude's 5-hour window is full and the task cannot go local", async () => {
    await writeReading(
      home,
      {
        plan: "claude",
        source: "test",
        windows: { "5h": { utilization: 1, resetsAt: NOW + 3_600_000 } },
      },
      NOW - 60_000,
    );
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classify: () => jevResult({ ...GOOD, visual: 0.1 }) });
    const route = await router.route(userRequest("Redo the title screen art"), ctx);
    expect(route.state).toMatchObject({ route: "spill", model: "openai/gpt-6.1-terra" });
  });

  it("keeps a visual brief off the local model when Claude's windows are full", async () => {
    await writeReading(
      home,
      {
        plan: "claude",
        source: "test",
        windows: {
          "5h": { utilization: 1, resetsAt: NOW + 3_600_000 },
          "7d": { utilization: 1, resetsAt: NOW + 86_400_000 },
        },
      },
      NOW - 60_000,
    );
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classify: () => jevResult({ ...GOOD, visual: 0.2 }) });
    const route = await router.route(userRequest("Make the menu screen look nicer"), ctx);
    expect(route.state?.route).not.toBe("local");
    expect((await readRecords(home, 1)).records[0]).toMatchObject({ pressure: true });
  });

  it("ends the request with a clear error when no plan has room, and stores no state", async () => {
    for (const plan of ["claude", "codex"]) {
      await writeReading(
        home,
        { plan, source: "test", windows: { "5h": { utilization: 1, resetsAt: NOW + 60_000 } } },
        NOW - 1_000,
      );
    }
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classify: () => jevResult({ ...GOOD, visual: 0.1 }) });
    await expect(router.route(userRequest("Redo the art"), ctx)).rejects.toThrow(NoRoomError);
    expect((await readRecords(home, 1)).records[0]).toMatchObject({
      route: "wait",
      resetsAt: NOW + 60_000,
    });
  });

  it("falls back to the cloud model on its own errors and records why", async () => {
    writeFileSync(join(home, "settings.json"), "{ broken");
    const { router } = harness();
    const { ctx, notices } = fakeContext(cwd);
    const route = await router.route(userRequest(BRIEF), ctx);
    expect(`${route.model.provider}/${route.model.id}`).toBe(SONNET);
    expect(route.state?.route).toBe("cloud");
    const record = (await readRecords(home, 1)).records[0];
    expect(record).toMatchObject({ kind: "error", route: "cloud" });
    expect(record?.reasons[0]).toMatch(/router error: .*settings\.json is not valid JSON/);
    expect(notices[0]?.type).toBe("warning");
  });
});

describe("Router: cloud model", () => {
  const AUTO_ERROR =
    /spore\/auto cannot be its own cloud model: set "router\.cloud" in .*settings\.json/;

  it("refuses spore/auto as router.cloud and does not fall back to it", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ router: { cloud: "spore/auto" } }));
    const { router } = harness({ workerModel: async () => "spore/auto" });
    const { ctx } = fakeContext(cwd);
    await expect(router.route(userRequest(BRIEF), ctx)).rejects.toThrow(AUTO_ERROR);
  });

  it("refuses spore/auto as the worker model when router.cloud is unset", async () => {
    writeFileSync(join(home, "settings.json"), "{}");
    const { router } = harness({ workerModel: async () => "spore/auto" });
    const { ctx } = fakeContext(cwd);
    await expect(router.route(userRequest(BRIEF), ctx)).rejects.toThrow(AUTO_ERROR);
  });
});

describe("Router: later requests", () => {
  const localState: RouterState = {
    route: "local",
    model: STRATA,
    failures: 0,
    decidedAt: NOW,
    reasons: [],
  };

  it("stays on the chosen model without asking Jev again", async () => {
    const { router } = harness();
    const { ctx, classifyCalls } = fakeContext(cwd);
    const route = await router.route(
      userRequest(BRIEF, { reason: "continuation", state: localState }),
      ctx,
    );
    expect(`${route.model.provider}/${route.model.id}`).toBe(STRATA);
    expect(route.state).toBeUndefined();
    expect(classifyCalls).toHaveLength(0);
  });

  it("waits for a busy local target, shows it, and takes the slot once it is free", async () => {
    const busy = new LocalLocks(lockFolder, 200, () => true);
    const held = await busy.tryAcquire(STRATA, 1, "other");
    const { router, sleeps } = harness(
      {
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 3) await busy.release(held as string);
        },
      },
      100,
      () => true,
    );
    const { ctx, notices, statuses } = fakeContext(cwd);
    const route = await router.route(userRequest(BRIEF, { state: localState }), ctx);
    expect(`${route.model.provider}/${route.model.id}`).toBe(STRATA);
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(notices.map((notice) => notice.message)).toContain(
      "Waiting for qwen3.8-flash-next-unsloth-ud-iq2_xs: another session is using it",
    );
    expect(statuses).toEqual(["Waiting for qwen3.8-flash-next-unsloth-ud-iq2_xs", undefined]);

    await router.releaseAll();
    expect(await busy.tryAcquire(STRATA, 1, "other")).toBeDefined();
  });

  it("escalates to the cloud model on a context overflow and frees the slot", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    await router.route(userRequest(BRIEF, { state: localState }), ctx);
    const failed = {
      model: { provider: "strata", id: "qwen3.8-flash-next-unsloth-ud-iq2_xs" },
      message: { role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" },
    };
    const route = await router.route(
      userRequest(BRIEF, { reason: "retry", state: localState, failed } as never),
      ctx,
    );
    expect(route.state).toMatchObject({ route: "cloud", model: SONNET });
    expect((await readRecords(home, 1)).records[0]).toMatchObject({
      kind: "escalation",
      reasons: ["context overflow on local"],
    });
    expect(
      await new LocalLocks(lockFolder, 200, () => true).tryAcquire(STRATA, 1, "x"),
    ).toBeDefined();
  });

  it("retries once on local, then escalates on the second failure", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    const failed = {
      model: { provider: "strata", id: "qwen3.8-flash-next-unsloth-ud-iq2_xs" },
      message: { role: "assistant", stopReason: "error", errorMessage: "connection reset" },
    };
    const first = await router.route(
      userRequest(BRIEF, { reason: "retry", state: localState, failed } as never),
      ctx,
    );
    expect(first.state).toMatchObject({ route: "local", failures: 1 });
    const second = await router.route(
      userRequest(BRIEF, { reason: "retry", state: first.state, failed } as never),
      ctx,
    );
    expect(second.state).toMatchObject({ route: "cloud", model: SONNET });
  });

  it("sends direct requests to the model that answered last", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    const previous = { model: { provider: "strata", id: "qwen3.8-flash-next-unsloth-ud-iq2_xs" } };
    const route = await router.route(userRequest("", { reason: "direct", previous } as never), ctx);
    expect(route.model).toBe(previous.model);
    expect(route.state).toBeUndefined();
  });
});

describe("Router: usage tap", () => {
  it("writes Claude windows from response headers and Codex windows from stream events", async () => {
    const { router } = harness();
    await router.onResponse({
      "anthropic-ratelimit-unified-5h-utilization": "0.3",
      "anthropic-ratelimit-unified-7d-utilization": "0.6",
    });
    await router.onResponse({ "content-type": "application/json" });
    await router.onStreamEvent({
      type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: 20, window_minutes: 10080 } },
    });
    await router.onStreamEvent({ type: "response.output_text.delta" });

    expect((await readPlan(home, "claude"))?.windows).toEqual({
      "5h": { utilization: 0.3, seenAt: NOW },
      "7d": { utilization: 0.6, seenAt: NOW },
    });
    expect((await readPlan(home, "codex"))?.windows).toEqual({
      "7d": { utilization: 0.2, seenAt: NOW },
    });
    expect(JSON.parse(readFileSync(join(home, "usage", "claude.json"), "utf8")).source).toBe(
      "anthropic-ratelimit-unified headers",
    );
  });
});
