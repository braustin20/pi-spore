import { describe, expect, it } from "vitest";
import { type DecideInput, decide, escalation, ladderChoice } from "./decide.js";
import { DEFAULT_SETTINGS, type RouterSettings } from "./settings.js";
import type { PlanState } from "./usage.js";

const settings: RouterSettings = { ...DEFAULT_SETTINGS };
const STRATA = "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs";
const good = {
  bounded: 0.95,
  explicit: 0.9,
  visual: 0.99,
  straightforward: 0.92,
  foundational: 0.9,
  design: 0.93,
};
const idle = { busy: false, waiting: 0 };
const room = (plan: string): PlanState => ({ plan, room: "room", pressure: false, notes: [] });
const full = (plan: string, resetsAt?: number): PlanState => ({
  plan,
  room: "full",
  pressure: true,
  notes: [],
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    settings,
    local: { model: STRATA, budget: 65_536, thinking: "high", queue: idle },
    estimate: 4_000,
    jev: good,
    plans: { claude: room("claude"), codex: room("codex"), openrouter: room("openrouter") },
    ...overrides,
  };
}

describe("decide rungs (ADR 0141)", () => {
  it("routes a routine task that fits to the local target on rung 1", () => {
    const decision = decide(input());
    expect(decision).toMatchObject({
      route: "local",
      rung: 1,
      plan: "claude",
      model: STRATA,
      thinking: "high",
      threshold: 0.7,
    });
  });

  it("puts a task on rung 2 when a cheap answer fails, and names it", () => {
    const decision = decide(input({ jev: { ...good, explicit: 0.69 } }));
    expect(decision).toMatchObject({
      route: "cloud",
      rung: 2,
      plan: "claude",
      model: "claude-bridge/claude-sonnet-5-5",
      thinking: "high",
    });
    expect(decision.reasons).toContain("rung 2: explicit: explicit 0.69 < 0.7");
  });

  it.each([
    ["visual", { visual: 0.4 }, "rung 3: visual: nonvisual 0.40 < 0.7"],
    ["design", { design: 0.4 }, "rung 3: design: given 0.40 < 0.7"],
    ["foundational", { foundational: 0.4 }, "rung 3: foundational: routine 0.40 < 0.7"],
  ])("puts a task on rung 3 when %s is likely", (_name, answers, reason) => {
    const decision = decide(input({ jev: { ...good, ...answers } }));
    expect(decision).toMatchObject({
      route: "cloud",
      rung: 3,
      model: "claude-bridge/claude-opus-5-5",
    });
    expect(decision.reasons).toContain(reason);
  });

  it("puts a task over router.large on rung 3, even over the local budget", () => {
    const decision = decide(input({ estimate: 100_001 }));
    expect(decision).toMatchObject({ rung: 3, model: "claude-bridge/claude-opus-5-5" });
    expect(decision.reasons).toContain(
      "rung 3: estimate 100001 tokens is over router.large 100000",
    );
  });

  it("puts a task over the local budget but under router.large on rung 1 cloud", () => {
    const decision = decide(input({ estimate: 70_000 }));
    expect(decision).toMatchObject({
      route: "cloud",
      rung: 1,
      model: "claude-bridge/claude-haiku-5-5",
    });
    expect(decision.reasons).toContain("estimate 70000 tokens is over the local budget of 65536");
  });

  it("puts a task on rung 3 after a classifier error or when Jev was not asked", () => {
    const failed = decide(input({ jev: { error: "Classifier failed (error)" } }));
    expect(failed).toMatchObject({ route: "cloud", rung: 3 });
    expect(failed.reasons).toContain("rung 3: Classifier failed (error)");
    const { jev: _asked, ...unasked } = input();
    expect(decide(unasked).rung).toBe(3);
  });

  it("sends rung 1 to the cloud when there is no local target", () => {
    const decision = decide(input({ local: { missing: "no local target in the catalog" } }));
    expect(decision).toMatchObject({
      route: "cloud",
      rung: 1,
      model: "claude-bridge/claude-haiku-5-5",
    });
    expect(decision.reasons).toContain("no local target in the catalog");
  });

  it("accepts 0.55 under usage pressure, but never relaxes the heavy check", () => {
    const pressured = { ...input().plans, claude: { ...room("claude"), pressure: true } };
    const lower = decide(input({ plans: pressured, jev: { ...good, bounded: 0.6 } }));
    expect(lower).toMatchObject({ route: "local", rung: 1, pressure: true, threshold: 0.55 });

    const visual = decide(input({ plans: pressured, jev: { ...good, visual: 0.6 } }));
    expect(visual).toMatchObject({ route: "cloud", rung: 3 });
    expect(visual.reasons).toContain("rung 3: visual: nonvisual 0.60 < 0.7");

    expect(decide(input({ jev: { ...good, bounded: 0.6 } })).rung).toBe(2);
  });

  it("takes the pressure of the first plan that is not full", () => {
    const plans = {
      claude: full("claude"),
      codex: { ...room("codex"), pressure: true },
      openrouter: room("openrouter"),
    };
    const decision = decide(input({ plans, jev: { ...good, bounded: 0.6 } }));
    expect(decision).toMatchObject({ route: "local", plan: "codex", pressure: true });
  });
});

describe("decide plans", () => {
  it.each([
    [2, { explicit: 0.5 }, "openai/gpt-6.1-sol"],
    [3, { visual: 0.1 }, "openai/gpt-6-astra"],
  ])("moves rung %i to Codex when Claude is full", (rung, answers, model) => {
    const plans = { claude: full("claude"), codex: room("codex") };
    const decision = decide(input({ plans, jev: { ...good, ...answers } }));
    expect(decision).toMatchObject({ route: "cloud", rung, plan: "codex", model });
    expect(decision.reasons).toContain("claude plan is full");
  });

  it("moves to OpenRouter when Claude and Codex are full, and says its usage is unknown", () => {
    const plans = { claude: full("claude"), codex: full("codex") };
    const decision = decide(input({ plans, jev: { ...good, explicit: 0.5 } }));
    expect(decision).toMatchObject({
      route: "cloud",
      rung: 2,
      plan: "openrouter",
      model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
      thinking: "high",
    });
    expect(decision.reasons).toContain("openrouter usage unknown, treated as room");
  });

  it("waits for the earliest reset when every plan is full", () => {
    const plans = {
      claude: full("claude", 9_000),
      codex: full("codex", 5_000),
      openrouter: full("openrouter"),
    };
    const decision = decide(input({ plans, jev: { ...good, visual: 0.1 } }));
    expect(decision).toMatchObject({ route: "wait", rung: 3, resetsAt: 5_000 });
    expect(decision.model).toBeUndefined();
    expect(decision.plan).toBeUndefined();
    expect(decision.thinking).toBeUndefined();
    expect(decision.reasons).toContain("every plan is full");
  });

  it("omits resetsAt when no full plan has one", () => {
    const plans = { claude: full("claude"), codex: full("codex"), openrouter: full("openrouter") };
    expect(decide(input({ plans })).resetsAt).toBeUndefined();
  });
});

describe("decide local queue", () => {
  const queued = (waiting: number, busy = true) =>
    ({ model: STRATA, budget: 65_536, thinking: "high", queue: { busy, waiting } }) as const;

  it("sends rung 1 to Haiku when the queue is long, and says why", () => {
    const decision = decide(input({ local: queued(1) }));
    expect(decision).toMatchObject({
      route: "cloud",
      rung: 1,
      plan: "claude",
      model: "claude-bridge/claude-haiku-5-5",
      thinking: "high",
    });
    expect(decision.reasons).toContain(`queue for ${STRATA} is 1; router.maxQueued is 1`);
  });

  it("sends a long queue to Luna on Codex, then on OpenRouter, as plans fill", () => {
    const codex = decide(input({ local: queued(1), plans: { claude: full("claude") } }));
    expect(codex).toMatchObject({ plan: "codex", model: "openai/gpt-6-luna", thinking: "xhigh" });
    const openrouter = decide(
      input({ local: queued(1), plans: { claude: full("claude"), codex: full("codex") } }),
    );
    expect(openrouter).toMatchObject({
      plan: "openrouter",
      model: "openrouter/openai/gpt-6-luna",
      thinking: "xhigh",
    });
  });

  it("stays local when busy but fewer than maxQueued wait", () => {
    expect(decide(input({ local: queued(0) }))).toMatchObject({ route: "local", rung: 1 });
  });

  it("goes to the cloud when maxQueued is 0 and the target is busy", () => {
    const strict = { ...settings, maxQueued: 0 };
    expect(decide(input({ settings: strict, local: queued(0) }))).toMatchObject({
      route: "cloud",
      model: "claude-bridge/claude-haiku-5-5",
    });
    expect(decide(input({ settings: strict, local: queued(0, false) })).route).toBe("local");
  });

  it("does not look at the queue for rung 2 or 3", () => {
    const decision = decide(input({ local: queued(5), jev: { ...good, explicit: 0.5 } }));
    expect(decision.rung).toBe(2);
    expect(decision.reasons.join()).not.toContain("router.maxQueued");
  });
});

describe("decide thinking", () => {
  it("takes the level from the ladder entry or the local target", () => {
    const thinking = (overrides: Partial<DecideInput>) => decide(input(overrides)).thinking;
    expect(thinking({})).toBe("high");
    expect(thinking({ jev: { ...good, explicit: 0.5 } })).toBe("high");
    expect(thinking({ jev: { ...good, visual: 0.5 } })).toBe("high");
    const target = { model: STRATA, budget: 65_536, thinking: "low", queue: idle } as const;
    expect(thinking({ local: target })).toBe("low");
  });

  it.each([
    ["claude-bridge/claude-haiku-5-5", "high"],
    ["claude-bridge/claude-sonnet-5-5", "high"],
    ["claude-bridge/claude-opus-5-5", "high"],
    ["openai/gpt-6-luna", "xhigh"],
    ["openai/gpt-6.1-sol", "high"],
    ["openai/gpt-6-astra", "high"],
    ["openrouter/openai/gpt-6-luna", "xhigh"],
    ["openrouter/deepseek/deepseek-v4.1-flash-1017", "high"],
    ["openrouter/openai/gpt-6.1-sol", "high"],
  ])("uses the default level of %s", (model, level) => {
    const entries = settings.ladders.flatMap((ladder) => ladder.rungs);
    expect(entries.find((entry) => entry.model === model)?.thinking).toBe(level);
  });
});

describe("explore (ADR 0144)", () => {
  const hard = { ...good, straightforward: 0.41 };

  it("sends the task local when straightforward is the only blocker, and says so", () => {
    const decision = decide(input({ jev: hard, explore: true }));
    expect(decision).toMatchObject({ route: "local", rung: 1, model: STRATA, explore: true });
    expect(decision.reasons).toContain("rung 1: straightforward: straightforward 0.41 < 0.7");
    expect(decision.reasons).toContain("explore: sent local to record an outcome (ADR 0144)");
  });

  it("goes to rung 2 when the explore draw missed", () => {
    const decision = decide(input({ jev: hard, explore: false }));
    expect(decision).toMatchObject({ route: "cloud", rung: 2 });
    expect(decision.explore).toBeUndefined();
  });

  it("sends a task local when visual is its only blocker, and names the visual answer (ADR 0173)", () => {
    const decision = decide(input({ jev: { ...good, visual: 0.2 }, explore: true }));
    expect(decision).toMatchObject({ route: "local", rung: 1, model: STRATA, explore: true });
    expect(decision.reasons).toContain("rung 1: visual: nonvisual 0.20 < 0.7");
  });

  it("keeps a task that fails both visual and straightforward on rung 3 (ADR 0173)", () => {
    const decision = decide(input({ jev: { ...hard, visual: 0.2 }, explore: true }));
    expect(decision).toMatchObject({
      route: "cloud",
      rung: 3,
      model: "claude-bridge/claude-opus-5-5",
    });
    expect(decision.explore).toBeUndefined();
    expect(decision.reasons).toContain("rung 3: visual: nonvisual 0.20 < 0.7");
  });

  it("keeps a visual task on rung 3 when the explore draw missed or the local target cannot take it", () => {
    const visual = { ...good, visual: 0.2 };
    expect(decide(input({ jev: visual, explore: false })).rung).toBe(3);
    expect(decide(input({ jev: visual, estimate: 70_000, explore: true }))).toMatchObject({
      route: "cloud",
      rung: 3,
    });
  });

  it.each([
    ["a visual and foundational task", { ...good, visual: 0.2, foundational: 0.2 }],
    ["a visual task where another cheap answer fails", { ...good, visual: 0.2, explicit: 0.3 }],
    ["a design task", { ...hard, design: 0.2 }],
    ["a foundational task", { ...hard, foundational: 0.2 }],
    ["a task where another cheap answer fails", { ...hard, bounded: 0.3 }],
    ["a classifier error", { error: "Classifier failed" }],
  ])("never explores %s", (_name, jev) => {
    expect(decide(input({ jev, explore: true })).route).toBe("cloud");
  });

  it("never explores a task over router.large", () => {
    expect(decide(input({ jev: hard, estimate: 100_001, explore: true })).rung).toBe(3);
  });

  it("never explores over the local budget, with a busy queue, or with no local target", () => {
    expect(decide(input({ jev: hard, estimate: 70_000, explore: true })).rung).toBe(2);
    const busy = {
      model: STRATA,
      budget: 65_536,
      thinking: "high",
      queue: { busy: true, waiting: 1 },
    } as const;
    expect(decide(input({ jev: hard, local: busy, explore: true })).rung).toBe(2);
    const none = { missing: "no local target" };
    expect(decide(input({ local: none, jev: hard, explore: true })).rung).toBe(2);
  });
});

describe("ladderChoice", () => {
  it("returns the rung's entry on the first plan that is not full", () => {
    const choice = ladderChoice(settings, 3, { claude: full("claude"), codex: room("codex") });
    expect(choice).toEqual({
      route: "cloud",
      plan: "codex",
      model: "openai/gpt-6-astra",
      thinking: "high",
      reasons: ["claude plan is full"],
    });
  });

  it("treats a plan with no state as room and says so", () => {
    expect(ladderChoice(settings, 1, {}).reasons).toEqual([
      "claude usage unknown, treated as room",
    ]);
  });

  it("reads an escalated rung from the same plan list", () => {
    expect(ladderChoice(settings, 2, { claude: room("claude") })).toMatchObject({
      plan: "claude",
      model: "claude-bridge/claude-sonnet-5-5",
    });
  });
});

describe("escalation", () => {
  it("escalates at once on a context overflow", () => {
    expect(escalation(0, { overflow: true })).toMatchObject({ escalate: true });
  });

  it("escalates on the second failure in a row, not the first", () => {
    const first = escalation(0, { overflow: false, errorMessage: "boom" });
    expect(first).toEqual({ escalate: false, failures: 1 });
    expect(escalation(first.failures, { overflow: false, errorMessage: "boom" })).toMatchObject({
      escalate: true,
      failures: 2,
      reason: "failed 2 times in a row: boom",
    });
  });

  it("does not count a busy queue as a failure", () => {
    expect(escalation(1, { overflow: false, errorMessage: "queue_wait_timeout" })).toEqual({
      escalate: false,
      failures: 1,
    });
  });
});
