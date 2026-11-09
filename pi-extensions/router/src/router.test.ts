import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalLocks } from "./lock.js";
import { readRecords } from "./records.js";
import {
  NoRoomError,
  Router,
  RouterConfigError,
  type RouterDeps,
  type RouterState,
} from "./router.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import {
  ASTRA,
  DEEPSEEK,
  fakeContext,
  GOOD,
  HAIKU,
  jevResult,
  LUNA,
  OPUS,
  OR_LUNA,
  OR_SOL,
  SOL,
  SONNET,
  STRATA,
  userRequest,
} from "./test-fakes.js";
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
  writeSettings({});
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeSettings = (router: unknown) =>
  writeFileSync(join(home, "settings.json"), JSON.stringify({ router }));

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
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    locks: () => locks,
    healthy: async () => health.ok,
    announceLocal: (target) => {
      announced.push(`${target.provider}/${target.modelId}`);
      return [];
    },
    isOverflow: (message) => message.errorMessage === "context_length_exceeded",
    ...overrides,
  });
  return { router, sleeps, announced, health };
}

const BRIEF = "In src/math.ts add clamp(value, min, max). Add a test. Run npm test.";

const ref = (route: { model: { provider: string; id: string } }): string =>
  `${route.model.provider}/${route.model.id}`;

/** A task of rung 2: cheap questions fail, heavy ones pass. */
const medium = () => jevResult({ ...GOOD, straightforward: 0.4 });
/** A task of rung 3. */
const visual = () => jevResult({ ...GOOD, visual: 0.2 });

/** Marks a plan's 5-hour window full until `resetsAt`. */
const fillPlan = (plan: string, resetsAt: number) =>
  writeReading(
    home,
    { plan, source: "test", windows: { "5h": { utilization: 1, resetsAt } } },
    NOW - 1_000,
  );

const failure = (model: string, errorMessage: string) => {
  const { provider, id } = {
    provider: model.split("/")[0],
    id: model.slice(model.indexOf("/") + 1),
  };
  return {
    model: { provider, id },
    message: { role: "assistant", stopReason: "error", errorMessage },
  };
};

const state = (overrides: Partial<RouterState> = {}): RouterState => ({
  route: "local",
  rung: 1,
  plan: "claude",
  model: STRATA,
  thinking: "high",
  failures: 0,
  decidedAt: NOW,
  reasons: [],
  ...overrides,
});

const cloudState = (model: string, rung: 1 | 2 | 3, overrides: Partial<RouterState> = {}) =>
  state({ route: "cloud", rung, model, ...overrides });

/** Holds Strata's only slot as another live process, and queues `waiting` more such processes. */
async function busyStrata(waiting: number): Promise<{ release(): Promise<void> }> {
  const holder = new LocalLocks(lockFolder, 200, () => true);
  const held = await holder.tryAcquire(STRATA, 1, "other");
  for (let i = 0; i < waiting; i++) {
    await new LocalLocks(lockFolder, 300 + i, () => true).joinQueue(STRATA, `waiter-${i}`);
  }
  return { release: () => holder.release(held as string) };
}
const LIVE = (pid: number) => [100, 200, 300, 301, 302].includes(pid);

const withLadders = (change: (ladders: typeof DEFAULT_SETTINGS.ladders) => void) => {
  const ladders = structuredClone(DEFAULT_SETTINGS.ladders);
  change(ladders);
  writeSettings({ ladders });
};

describe("Router: first request of a session", () => {
  it("routes a bounded task local, holds the slot, starts the target, and records why", async () => {
    const { router, announced } = harness();
    const { ctx, notices, classifyCalls } = fakeContext(cwd);

    const route = await router.route(userRequest(BRIEF), ctx);

    expect(ref(route)).toBe(STRATA);
    expect(route.thinkingLevel).toBe("high");
    expect(route.state).toMatchObject({
      route: "local",
      rung: 1,
      plan: "claude",
      model: STRATA,
      thinking: "high",
      failures: 0,
    });
    expect(classifyCalls).toHaveLength(1);
    expect(announced).toEqual([STRATA]);
    expect(notices[0]?.message).toMatch(/^spore\/auto: rung 1 local → strata\/.* \(high\) \(/);

    const { records } = await readRecords(home, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "initial",
      route: "local",
      rung: 1,
      plan: "claude",
      model: STRATA,
      thinking: "high",
      agentId: "agent-1",
      workspaceId: "ws-1",
      sessionId: "session-1",
      budget: 65_536,
      jev: GOOD,
      threshold: 0.7,
      heavyThreshold: 0.7,
      pressure: false,
    });
    expect(records[0]?.estimate).toBeGreaterThan(5);
    expect(records[0]?.usage).toEqual([
      "claude: no usage seen",
      "codex: no usage seen",
      "openrouter: no usage seen",
    ]);
  });

  it("goes to the next rung when the cheap answer fails, and to rung 3 for a visual task", async () => {
    const { router } = harness();
    const middle = fakeContext(cwd, { classify: medium });
    const second = await router.route(userRequest(BRIEF), middle.ctx);
    expect(ref(second)).toBe(SONNET);
    expect(second.thinkingLevel).toBe("high");
    expect(second.state).toMatchObject({ route: "cloud", rung: 2, plan: "claude", model: SONNET });
    expect(middle.notices[0]?.message).toMatch(
      /^spore\/auto: rung 2 claude → claude-bridge\/claude-sonnet-5-5 \(high\) \(/,
    );

    const heavy = fakeContext(cwd, { classify: visual });
    const third = await router.route(userRequest("Make the menu screen look nicer"), heavy.ctx);
    expect(ref(third)).toBe(OPUS);
    expect(third.state).toMatchObject({ route: "cloud", rung: 3, plan: "claude", model: OPUS });
    const { records } = await readRecords(home, 1);
    expect(records[0]).toMatchObject({ kind: "initial", route: "cloud", rung: 3, plan: "claude" });
    expect(records[0]?.reasons).toContain("rung 3: visual: nonvisual 0.20 < 0.7");
  });

  it("sends a design or foundational task to rung 3", async () => {
    const { router } = harness();
    for (const answers of [{ design: 0.3 }, { foundational: 0.3 }]) {
      const { ctx } = fakeContext(cwd, { classify: () => jevResult({ ...GOOD, ...answers }) });
      expect(ref(await router.route(userRequest(BRIEF), ctx))).toBe(OPUS);
    }
  });

  describe("explore (ADR 0144)", () => {
    const hard = () => jevResult({ ...GOOD, straightforward: 0.41 });
    const workerEnv = { PI_SPORE_AGENT_ID: "agent-1", PI_SPORE_STAGE_ROLE: "worker" };

    it("sends a worker stage local when only the straightforward answer fails, and records it", async () => {
      writeSettings({ explore: 1 });
      const { router } = harness({ env: workerEnv });
      const { ctx } = fakeContext(cwd, { classify: hard });
      const route = await router.route(userRequest(BRIEF), ctx);
      expect(route.state).toMatchObject({ route: "local", model: STRATA });
      const { records } = await readRecords(home, 1);
      expect(records[0]).toMatchObject({ route: "local", explore: true });
      expect(records[0]?.reasons).toContain("rung 1: straightforward: straightforward 0.41 < 0.7");
    });

    it("routes the same task to rung 2 when explore is 0", async () => {
      writeSettings({ explore: 0 });
      const { router } = harness({ env: workerEnv, random: () => 0 });
      const { ctx } = fakeContext(cwd, { classify: hard });
      const route = await router.route(userRequest(BRIEF), ctx);
      expect(route.state).toMatchObject({ route: "cloud", rung: 2 });
      const { records } = await readRecords(home, 1);
      expect(records[0]?.explore).toBeUndefined();
    });

    it("does not explore outside a worker stage", async () => {
      writeSettings({ explore: 1 });
      const { router } = harness({ env: { PI_SPORE_AGENT_ID: "agent-1" } });
      const { ctx } = fakeContext(cwd, { classify: hard });
      const route = await router.route(userRequest(BRIEF), ctx);
      expect(route.state?.route).toBe("cloud");
    });
  });

  it("asks the classifier also when the task is over the local budget, and uses rung 1 in the cloud", async () => {
    writeFileSync(join(cwd, "src", "big.ts"), "x".repeat(300_000));
    const { router } = harness();
    const { ctx, classifyCalls } = fakeContext(cwd);
    const route = await router.route(userRequest("Refactor src/big.ts"), ctx);
    expect(ref(route)).toBe(HAIKU);
    expect(route.state).toMatchObject({ route: "cloud", rung: 1 });
    expect(classifyCalls).toHaveLength(1);
    expect((await readRecords(home, 1)).records[0]?.reasons).toContainEqual(
      expect.stringMatching(/is over the local budget of 65536/),
    );
  });

  it("sends a task above router.large to rung 3", async () => {
    writeFileSync(join(cwd, "src", "huge.ts"), "x".repeat(500_000));
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    expect(ref(await router.route(userRequest("Refactor src/huge.ts"), ctx))).toBe(OPUS);
  });

  it("counts the system prompt in the estimate", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { systemPrompt: "s".repeat(280_000) });
    const route = await router.route(userRequest(BRIEF), ctx);
    expect(route.state).toMatchObject({ route: "cloud", rung: 1 });
    expect((await readRecords(home, 1)).records[0]?.estimate).toBeGreaterThan(70_000);
  });

  it("goes to rung 3 and records it when the classifier is missing", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classifier: false });
    const route = await router.route(userRequest(BRIEF), ctx);
    expect(route.state).toMatchObject({ route: "cloud", rung: 3, model: OPUS });
    expect((await readRecords(home, 1)).records[0]?.reasons).toContain(
      "rung 3: classifier openrouter/~typesafe/jev-latest is not in the catalog",
    );
  });

  it("goes to rung 1 in the cloud when the local target is not in the catalog", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd, {
      models: [HAIKU, SONNET, OPUS, LUNA, SOL, ASTRA, OR_LUNA, DEEPSEEK, OR_SOL],
    });
    const route = await router.route(userRequest(BRIEF), ctx);
    expect(ref(route)).toBe(HAIKU);
    expect((await readRecords(home, 1)).records[0]?.reasons).toContain(
      "no local target in the catalog",
    );
  });

  it("goes to the cloud when the lock folder cannot exist", async () => {
    const { router } = harness({
      locks: () => {
        throw new Error("XDG_RUNTIME_DIR is not set");
      },
    });
    const { ctx } = fakeContext(cwd);
    expect(ref(await router.route(userRequest(BRIEF), ctx))).toBe(HAIKU);
    expect((await readRecords(home, 1)).records[0]?.reasons).toContain(
      "XDG_RUNTIME_DIR is not set",
    );
  });

  it("goes to the cloud when the local target does not answer its health URL, and frees the slot", async () => {
    const first = harness();
    first.health.ok = false;
    const { ctx } = fakeContext(cwd);
    const route = await first.router.route(userRequest(BRIEF), ctx);
    expect(route.state).toMatchObject({ route: "cloud", rung: 1, model: HAIKU });
    expect((await readRecords(home, 1)).records[0]?.reasons).toContain(
      `local target not ready: ${STRATA} does not answer at http://127.0.0.1:8080/health`,
    );
    const other = new LocalLocks(lockFolder, 200, () => true);
    expect(await other.tryAcquire(STRATA, 1, "s2")).toBeDefined();
  });

  it("lowers the cheap threshold under Claude usage pressure", async () => {
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

  it("never lowers the visual check under pressure", async () => {
    await writeReading(
      home,
      { plan: "claude", source: "test", windows: { "7d": { utilization: 0.8 } } },
      NOW - 60_000,
    );
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classify: () => jevResult({ ...GOOD, visual: 0.6 }) });
    expect(ref(await router.route(userRequest(BRIEF), ctx))).toBe(OPUS);
  });
});

describe("Router: plans with and without room", () => {
  it("moves to Codex on the same rung when Claude's plan is full", async () => {
    await fillPlan("claude", NOW + 3_600_000);
    const { router } = harness();
    const rungs: [() => unknown, string, 2 | 3][] = [
      [medium, SOL, 2],
      [visual, ASTRA, 3],
    ];
    for (const [classify, model, rung] of rungs) {
      const { ctx } = fakeContext(cwd, { classify });
      const route = await router.route(userRequest(BRIEF), ctx);
      expect(ref(route)).toBe(model);
      expect(route.state).toMatchObject({ route: "cloud", rung, plan: "codex" });
    }
  });

  it("moves to OpenRouter when Claude and Codex are full, also when its plan has numbers", async () => {
    await fillPlan("claude", NOW + 3_600_000);
    await fillPlan("codex", NOW + 3_600_000);
    const { router } = harness();
    const unknown = await router.route(
      userRequest(BRIEF),
      fakeContext(cwd, { classify: visual }).ctx,
    );
    expect(ref(unknown)).toBe(OR_SOL);
    expect(unknown.state).toMatchObject({ rung: 3, plan: "openrouter", thinking: "high" });

    await writeReading(
      home,
      { plan: "openrouter", source: "test", windows: { "5h": { utilization: 0.5 } } },
      NOW - 1_000,
    );
    const seen = await router.route(userRequest(BRIEF), fakeContext(cwd, { classify: medium }).ctx);
    expect(ref(seen)).toBe(DEEPSEEK);
  });

  it("ends the request with an error naming the first reset when every plan is full, and stores no state", async () => {
    await fillPlan("claude", NOW + 3_600_000);
    await fillPlan("codex", NOW + 60_000);
    await fillPlan("openrouter", NOW + 120_000);
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { classify: visual });
    const failed = router.route(userRequest("Redo the art"), ctx);
    await expect(failed).rejects.toThrow(NoRoomError);
    await expect(failed).rejects.toThrow(new Date(NOW + 60_000).toISOString());
    expect((await readRecords(home, 1)).records[0]).toMatchObject({
      route: "wait",
      resetsAt: NOW + 60_000,
    });
  });
});

describe("Router: the local queue", () => {
  const settingsWithHolder = async (waiting: number) => {
    const busy = await busyStrata(waiting);
    return { busy, ...harness({}, 100, LIVE) };
  };

  it("sends a rung-1 task to Haiku when the queue is full, then to Luna and OpenRouter's Luna", async () => {
    await settingsWithHolder(1);
    const { router } = harness({}, 100, LIVE);
    const run = async () => {
      const { ctx } = fakeContext(cwd);
      return router.route(userRequest(BRIEF), ctx);
    };

    const first = await run();
    expect(ref(first)).toBe(HAIKU);
    expect(first.state).toMatchObject({ route: "cloud", rung: 1, thinking: "high" });
    expect((await readRecords(home, 1)).records[0]?.reasons).toContainEqual(
      expect.stringMatching(/queue for strata.* is 1; router\.maxQueued is 1/),
    );

    await fillPlan("claude", NOW + 3_600_000);
    const second = await run();
    expect(ref(second)).toBe(LUNA);
    expect(second.thinkingLevel).toBe("xhigh");

    await fillPlan("codex", NOW + 3_600_000);
    const third = await run();
    expect(ref(third)).toBe(OR_LUNA);
    expect(third.thinkingLevel).toBe("xhigh");
  });

  it("does not count wait files of dead processes", async () => {
    const { release } = await busyStrata(1);
    // Process 300 is gone, so nobody waits: the task joins the queue and takes the slot once it is free.
    const { router, sleeps } = harness(
      {
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 2) await release();
        },
      },
      100,
      (pid) => pid === 100 || pid === 200,
    );
    const { ctx } = fakeContext(cwd);
    const route = await router.route(userRequest(BRIEF), ctx);
    expect(ref(route)).toBe(STRATA);
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(readdirSync(lockFolder).filter((name) => name.includes(".wait."))).toEqual([]);
  });

  it("goes to the cloud at once when router.maxQueued is 0 and the target is busy", async () => {
    writeSettings({ maxQueued: 0 });
    await busyStrata(0);
    const { router } = harness({}, 100, LIVE);
    const { ctx } = fakeContext(cwd);
    expect(ref(await router.route(userRequest(BRIEF), ctx))).toBe(HAIKU);
  });
});

describe("Router: thinking level", () => {
  it("uses the level of the ladder entry, never the one the user picked", async () => {
    await busyStrata(1);
    for (const level of ["low", "max"] as const) {
      const { router } = harness({}, 100, LIVE);
      await fillPlan("claude", NOW + 3_600_000);
      const rungOne = await router.route(
        userRequest(BRIEF, { thinkingLevel: level }),
        fakeContext(cwd).ctx,
      );
      expect([ref(rungOne), rungOne.thinkingLevel]).toEqual([LUNA, "xhigh"]);
    }
  });

  it.each([
    ["local", () => jevResult(GOOD), STRATA],
    ["rung 2", medium, SONNET],
    ["rung 3", visual, OPUS],
  ] as const)("uses high for %s whatever level the user picked", async (_name, classify, model) => {
    const { router } = harness();
    for (const level of ["low", "max"] as const) {
      const { ctx } = fakeContext(cwd, { classify });
      const route = await router.route(userRequest(BRIEF, { thinkingLevel: level }), ctx);
      expect([ref(route), route.thinkingLevel]).toEqual([model, "high"]);
    }
  });

  it("keeps the stored level on later requests", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    const route = await router.route(
      userRequest(BRIEF, {
        reason: "continuation",
        thinkingLevel: "off",
        state: cloudState(OR_LUNA, 1, { plan: "openrouter", thinking: "xhigh" }),
      }),
      ctx,
    );
    expect([ref(route), route.thinkingLevel]).toEqual([OR_LUNA, "xhigh"]);
  });
});

describe("Router: settings errors", () => {
  it("refuses a thinking level the model lacks, and does not fall back", async () => {
    withLadders((ladders) => {
      (ladders[2]?.rungs[1] as { thinking: string }).thinking = "xhigh";
    });
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    const failed = router.route(userRequest(BRIEF), ctx);
    await expect(failed).rejects.toThrow(RouterConfigError);
    await expect(failed).rejects.toThrow(
      `router.ladders[2].rungs[1].thinking xhigh: ${DEEPSEEK} takes off, low, high, max`,
    );
    expect((await readRecords(home, 10)).records).toEqual([]);
  });

  it("refuses a ladder model that is not in the catalog", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { models: [STRATA, HAIKU, SONNET] });
    await expect(router.route(userRequest(BRIEF), ctx)).rejects.toThrow(
      `router.ladders[0].rungs[2].model ${OPUS} is not in Pi's model catalog`,
    );
    expect((await readRecords(home, 10)).records).toEqual([]);
  });

  it("refuses a thinking level the local target lacks", async () => {
    writeSettings({
      localTargets: [
        { model: STRATA, thinking: "xhigh", contextWindow: 131072, budget: 0.5, concurrency: 1 },
      ],
    });
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    await expect(router.route(userRequest(BRIEF), ctx)).rejects.toThrow(
      `router.localTargets[0].thinking xhigh: ${STRATA} takes off, minimal, low, medium, high`,
    );
  });

  it("checks the entries on every request, also continuations and direct requests", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd, { models: [STRATA, HAIKU, SONNET] });
    for (const reason of ["continuation", "direct"] as const) {
      await expect(
        router.route(userRequest(BRIEF, { reason, state: state() }), ctx),
      ).rejects.toThrow(RouterConfigError);
    }
  });

  it("refuses Fable in a ladder, and never routes to it", async () => {
    withLadders((ladders) => {
      (ladders[0]?.rungs[2] as { model: string }).model = "claude-bridge/claude-fable-5-1";
    });
    const { router } = harness();
    await expect(router.route(userRequest(BRIEF), fakeContext(cwd).ctx)).rejects.toThrow(
      /claude-fable-5-1 is tier top/,
    );

    writeSettings({});
    const routed = new Set<string>();
    for (const classify of [() => jevResult(GOOD), medium, visual]) {
      const route = await router.route(userRequest(BRIEF), fakeContext(cwd, { classify }).ctx);
      routed.add(ref(route));
    }
    expect([...routed].some((model) => model.includes("fable"))).toBe(false);
  });

  it.each(["cloud", "spill"])("refuses router.%s and names router.ladders", async (key) => {
    writeSettings({ [key]: key === "cloud" ? SONNET : [SONNET] });
    const { router } = harness();
    await expect(router.route(userRequest(BRIEF), fakeContext(cwd).ctx)).rejects.toThrow(
      /router\.ladders/,
    );
  });

  it("ends the request when settings.json is not valid JSON", async () => {
    writeFileSync(join(home, "settings.json"), "{ broken");
    const { router } = harness();
    await expect(router.route(userRequest(BRIEF), fakeContext(cwd).ctx)).rejects.toThrow(
      /settings\.json is not valid JSON/,
    );
  });
});

describe("Router: router errors", () => {
  it("routes to the first ladder's rung 3, pins the session there, and records why", async () => {
    const { router } = harness();
    const { ctx, notices } = fakeContext(cwd);
    ctx.getSystemPrompt = () => {
      throw new Error("prompt is gone");
    };
    const route = await router.route(userRequest(BRIEF, { thinkingLevel: "low" }), ctx);
    expect([ref(route), route.thinkingLevel]).toEqual([OPUS, "high"]);
    expect(route.state).toMatchObject({
      route: "cloud",
      rung: 3,
      plan: "claude",
      model: OPUS,
      thinking: "high",
    });
    const record = (await readRecords(home, 1)).records[0];
    expect(record).toMatchObject({
      kind: "error",
      route: "cloud",
      rung: 3,
      plan: "claude",
      model: OPUS,
      thinking: "high",
    });
    expect(record?.reasons).toEqual(["router error: prompt is gone"]);
    expect(notices[0]).toMatchObject({ type: "warning" });
    expect(notices[0]?.message).toMatch(/^spore\/auto: rung 3 claude → /);
  });
});

describe("Router: later requests", () => {
  it("stays on the chosen model and level without asking Jev again", async () => {
    const { router } = harness();
    const { ctx, classifyCalls } = fakeContext(cwd, { classify: visual });
    const first = await router.route(userRequest(BRIEF), ctx);
    const route = await router.route(
      userRequest(BRIEF, { reason: "continuation", state: first.state as RouterState }),
      ctx,
    );
    expect([ref(route), route.thinkingLevel]).toEqual([OPUS, "high"]);
    expect(route.state).toBeUndefined();
    expect(classifyCalls).toHaveLength(1);
  });

  it("stays on a local model without asking Jev again", async () => {
    const { router } = harness();
    const { ctx, classifyCalls } = fakeContext(cwd);
    const route = await router.route(
      userRequest(BRIEF, { reason: "continuation", state: state() }),
      ctx,
    );
    expect(ref(route)).toBe(STRATA);
    expect(route.state).toBeUndefined();
    expect(classifyCalls).toHaveLength(0);
  });

  it("decides again once when the state is from before ADR 0141", async () => {
    const { router } = harness();
    const { ctx, classifyCalls } = fakeContext(cwd, { classify: visual });
    const old = { route: "cloud", model: SONNET, failures: 0, decidedAt: NOW, reasons: [] };
    const route = await router.route(
      userRequest(BRIEF, { reason: "continuation", state: old as never }),
      ctx,
    );
    expect(classifyCalls).toHaveLength(1);
    expect(ref(route)).toBe(OPUS);
    expect(route.state).toMatchObject({ rung: 3 });
  });

  it("waits for a busy local target, shows it, joins the queue, and takes the slot once it is free", async () => {
    const busy = new LocalLocks(lockFolder, 200, () => true);
    const held = await busy.tryAcquire(STRATA, 1, "other");
    const waitFiles = () => readdirSync(lockFolder).filter((name) => name.includes(".wait."));
    const during: string[][] = [];
    const { router, sleeps } = harness(
      {
        sleep: async (ms) => {
          sleeps.push(ms);
          during.push(waitFiles());
          if (sleeps.length === 3) await busy.release(held as string);
        },
      },
      100,
      () => true,
    );
    const { ctx, notices, statuses } = fakeContext(cwd);
    const route = await router.route(
      userRequest(BRIEF, { reason: "continuation", state: state() }),
      ctx,
    );
    expect(ref(route)).toBe(STRATA);
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(during.every((files) => files.length === 1)).toBe(true);
    expect(waitFiles()).toEqual([]);
    expect(notices.map((notice) => notice.message)).toContain(
      "Waiting for qwen3.8-flash-next-unsloth-ud-iq2_xs: another session is using it",
    );
    expect(statuses).toEqual(["Waiting for qwen3.8-flash-next-unsloth-ud-iq2_xs", undefined]);

    await router.releaseAll();
    expect(await busy.tryAcquire(STRATA, 1, "other")).toBeDefined();
  });

  it("sends direct requests to the model and level that answered last", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    const model = { provider: "strata", id: "qwen3.8-flash-next-unsloth-ud-iq2_xs" };
    const withLevel = await router.route(
      userRequest("", { reason: "direct", previous: { model, thinkingLevel: "low" } } as never),
      ctx,
    );
    expect(withLevel.model).toBe(model);
    expect(withLevel.thinkingLevel).toBe("low");
    expect(withLevel.state).toBeUndefined();

    const stored = await router.route(
      userRequest("", {
        reason: "direct",
        previous: { model },
        state: state({ thinking: "medium" }),
      } as never),
      ctx,
    );
    expect(stored.thinkingLevel).toBe("medium");

    const bare = await router.route(
      userRequest("", { reason: "direct", previous: { model } } as never),
      ctx,
    );
    expect(bare.thinkingLevel).toBe("high");
  });

  it("sends a direct request with no previous model to the first ladder's rung 1", async () => {
    const { router } = harness();
    const route = await router.route(
      userRequest("", { reason: "direct", thinkingLevel: "off" }),
      fakeContext(cwd).ctx,
    );
    expect([ref(route), route.thinkingLevel]).toEqual([HAIKU, "high"]);
    expect(route.state).toBeUndefined();
  });
});

describe("Router: escalation", () => {
  const retry = (current: RouterState, error: string) =>
    userRequest(BRIEF, {
      reason: "retry",
      state: current,
      failed: failure(current.model, error),
    } as never);

  it("moves a local session to rung 2 on a context overflow, records it, and frees the slot", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    await router.route(userRequest(BRIEF, { state: state() }), ctx);
    const route = await router.route(retry(state(), "context_length_exceeded"), ctx);
    expect(route.state).toMatchObject({ route: "cloud", rung: 2, plan: "claude", model: SONNET });
    expect((await readRecords(home, 1)).records[0]).toMatchObject({
      kind: "escalation",
      route: "cloud",
      rung: 2,
      plan: "claude",
      model: SONNET,
      thinking: "high",
      reasons: ["context overflow", "claude usage unknown, treated as room"],
    });
    expect(
      await new LocalLocks(lockFolder, 200, () => true).tryAcquire(STRATA, 1, "x"),
    ).toBeDefined();
  });

  it("moves a local session to rung 2 on the first plan with room", async () => {
    await fillPlan("claude", NOW + 3_600_000);
    const { router } = harness();
    const route = await router.route(
      retry(state(), "context_length_exceeded"),
      fakeContext(cwd).ctx,
    );
    expect(route.state).toMatchObject({ rung: 2, plan: "codex", model: SOL });
  });

  it("retries once on local, then escalates on the second failure", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    const first = await router.route(retry(state(), "connection reset"), ctx);
    expect(first.state).toMatchObject({ route: "local", failures: 1 });
    const second = await router.route(retry(first.state as RouterState, "connection reset"), ctx);
    expect(second.state).toMatchObject({ route: "cloud", rung: 2, model: SONNET });
  });

  it("moves a local session up when its target is no longer in the settings", async () => {
    const { router } = harness();
    const route = await router.route(
      userRequest(BRIEF, { reason: "continuation", state: state({ model: "strata/gone" }) }),
      fakeContext(cwd).ctx,
    );
    expect(route.state).toMatchObject({ rung: 2, model: SONNET });
    expect((await readRecords(home, 1)).records[0]?.reasons[0]).toBe(
      "strata/gone is no longer a local target",
    );
  });

  it("moves a cloud session from rung 1 to rung 2 on the second failure in a row", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    const rungOne = cloudState(HAIKU, 1);
    const first = await router.route(retry(rungOne, "connection reset"), ctx);
    expect(ref(first)).toBe(HAIKU);
    expect(first.state).toMatchObject({ rung: 1, failures: 1 });
    const second = await router.route(retry(first.state as RouterState, "connection reset"), ctx);
    expect(ref(second)).toBe(SONNET);
    expect(second.state).toMatchObject({ route: "cloud", rung: 2, plan: "claude", failures: 0 });
    expect((await readRecords(home, 1)).records[0]).toMatchObject({
      kind: "escalation",
      rung: 2,
      model: SONNET,
    });
  });

  it("resets the failure count of a cloud session after a request that did not fail", async () => {
    const { router } = harness();
    const route = await router.route(
      userRequest(BRIEF, { reason: "continuation", state: cloudState(HAIKU, 1, { failures: 1 }) }),
      fakeContext(cwd).ctx,
    );
    expect(route.state).toMatchObject({ rung: 1, failures: 0 });
  });

  it("measures overflow against the context window of the model that failed", async () => {
    const windows: (number | undefined)[] = [];
    const { router } = harness({
      isOverflow: (_message, contextWindow) => {
        windows.push(contextWindow);
        return false;
      },
    });
    const { ctx } = fakeContext(cwd);
    await router.route(retry(state(), "boom"), ctx);
    await router.route(retry(cloudState(HAIKU, 1), "boom"), ctx);
    expect(windows).toEqual([131_072, 200_000]);
  });

  it("keeps a rung-3 session on its model and does not record anything", async () => {
    const { router } = harness();
    const { ctx } = fakeContext(cwd);
    const current = cloudState(OPUS, 3);
    const first = await router.route(retry(current, "connection reset"), ctx);
    const second = await router.route(retry(current, "context_length_exceeded"), ctx);
    for (const route of [first, second]) {
      expect(ref(route)).toBe(OPUS);
      expect(route.state).toBeUndefined();
    }
    expect((await readRecords(home, 1)).records).toEqual([]);
  });

  it("ends the request when no plan has room for the next rung", async () => {
    for (const plan of ["claude", "codex", "openrouter"]) await fillPlan(plan, NOW + 60_000);
    const { router } = harness();
    await expect(
      router.route(retry(cloudState(HAIKU, 1, { failures: 1 }), "boom"), fakeContext(cwd).ctx),
    ).rejects.toThrow(NoRoomError);
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
