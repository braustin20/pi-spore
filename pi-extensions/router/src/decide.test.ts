import { describe, expect, it } from "vitest";
import { type DecideInput, decide, escalation } from "./decide.js";
import { DEFAULT_SETTINGS, type RouterSettings } from "./settings.js";
import type { PlanState } from "./usage.js";

const settings: RouterSettings = { ...DEFAULT_SETTINGS };
const STRATA = "strata/qwen3.8-flash-next-unsloth-ud-iq2_xs";
const SONNET = "claude-bridge/claude-sonnet-5-5";
const good = { bounded: 0.95, explicit: 0.9, visual: 0.99, straightforward: 0.92 };
const room = (plan: string): PlanState => ({ plan, room: "room", pressure: false, notes: [] });

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    settings,
    cloud: SONNET,
    local: { model: STRATA, budget: 65_536 },
    estimate: 4_000,
    jev: good,
    plans: { claude: room("claude"), codex: room("codex") },
    ...overrides,
  };
}

describe("decide", () => {
  it("routes a bounded, explicit, non-visual, straightforward task that fits to the local target", () => {
    const decision = decide(input());
    expect(decision.route).toBe("local");
    expect(decision.model).toBe(STRATA);
    expect(decision.threshold).toBe(0.7);
  });

  it("goes to the cloud model when one good answer is below 0.7, and names it", () => {
    const decision = decide(input({ jev: { ...good, explicit: 0.69 } }));
    expect(decision).toMatchObject({ route: "cloud", model: SONNET });
    expect(decision.reasons).toContain("explicit: explicit 0.69 < 0.7");
  });

  it("goes to the cloud model when the estimate is over the local budget, without needing Jev", () => {
    const decision = decide(input({ estimate: 70_000 }));
    expect(decision.route).toBe("cloud");
    expect(decision.reasons[0]).toMatch(/over the local budget of 65536/);
  });

  it("goes to the cloud model when the classifier failed or there is no local target", () => {
    expect(decide(input({ jev: { error: "Classifier failed (error)" } })).reasons).toEqual([
      "Classifier failed (error)",
    ]);
    expect(decide(input({ local: { missing: "no local target in the catalog" } })).route).toBe(
      "cloud",
    );
  });

  it("accepts 0.55 under usage pressure, but never relaxes the visual check", () => {
    const pressured = { claude: { ...room("claude"), pressure: true }, codex: room("codex") };
    const lower = decide(input({ plans: pressured, jev: { ...good, bounded: 0.6 } }));
    expect(lower).toMatchObject({ route: "local", pressure: true, threshold: 0.55 });

    const visual = decide(input({ plans: pressured, jev: { ...good, visual: 0.6 } }));
    expect(visual.route).toBe("cloud");
    expect(visual.reasons).toContain("visual: nonvisual 0.60 < 0.7");

    expect(decide(input({ jev: { ...good, bounded: 0.6 } })).route).toBe("cloud");
  });

  it("spills to the same-tier Codex model when Claude is full, and says Codex usage is unknown", () => {
    const plans = {
      claude: { plan: "claude", room: "full" as const, pressure: true, notes: [] },
      codex: { plan: "codex", room: "unknown" as const, pressure: false, notes: [] },
    };
    const decision = decide(input({ plans, jev: { ...good, visual: 0.1 } }));
    expect(decision).toMatchObject({ route: "spill", model: "openai/gpt-6.1-terra" });
    expect(decision.reasons.at(-1)).toMatch(/codex usage unknown, treated as room/);
  });

  it("waits for the first reset when Claude and Codex are both full", () => {
    const plans = {
      claude: { plan: "claude", room: "full" as const, pressure: true, resetsAt: 9_000, notes: [] },
      codex: { plan: "codex", room: "full" as const, pressure: true, resetsAt: 5_000, notes: [] },
    };
    const decision = decide(input({ plans, estimate: 99_999 }));
    expect(decision).toMatchObject({ route: "wait", resetsAt: 5_000 });
    expect(decision.model).toBeUndefined();
  });

  it("fails loudly when the cloud model has no tier and its plan is full", () => {
    const plans = {
      claude: { plan: "claude", room: "full" as const, pressure: true, notes: [] },
      codex: room("codex"),
    };
    expect(() =>
      decide(input({ cloud: "claude-bridge/claude-unknown", plans, estimate: 99_999 })),
    ).toThrow('claude-bridge/claude-unknown has no tier; add it to "tiers" in settings.json');
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
      reason: "failed 2 times on local: boom",
    });
  });

  it("does not count a busy queue as a failure", () => {
    expect(escalation(1, { overflow: false, errorMessage: "queue_wait_timeout" })).toEqual({
      escalate: false,
      failures: 1,
    });
  });
});
