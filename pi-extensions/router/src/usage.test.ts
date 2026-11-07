import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  planState,
  readHeaders,
  readPlan,
  readPlans,
  readStreamEvent,
  windowViews,
  writeReading,
} from "./usage.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-spore-usage-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** What pi-claude-bridge builds from a Claude Code rate_limit_event. */
const bridgeHeaders = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-reset": "1794020000",
  "anthropic-ratelimit-unified-5h-utilization": "0.42",
  "anthropic-ratelimit-unified-5h-reset": "1794020000",
  "anthropic-ratelimit-unified-7d-utilization": "0.8",
  "anthropic-ratelimit-unified-7d-reset": "1794500000",
};

describe("readHeaders", () => {
  it("reads Claude's unified windows as fractions with reset times in ms", () => {
    expect(readHeaders(bridgeHeaders)).toEqual([
      {
        plan: "claude",
        source: "anthropic-ratelimit-unified headers",
        status: "allowed",
        windows: {
          "5h": { utilization: 0.42, resetsAt: 1_794_020_000_000 },
          "7d": { utilization: 0.8, resetsAt: 1_794_500_000_000 },
        },
      },
    ]);
  });

  it("reads Codex's primary and secondary windows from x-codex headers", () => {
    expect(
      readHeaders({
        "x-codex-primary-used-percent": "12.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1794020000",
        "x-codex-secondary-used-percent": "40",
        "x-codex-secondary-window-minutes": "10080",
      }),
    ).toEqual([
      {
        plan: "codex",
        source: "x-codex headers",
        windows: {
          "5h": { utilization: 0.125, resetsAt: 1_794_020_000_000 },
          "7d": { utilization: 0.4 },
        },
      },
    ]);
  });

  it("ignores responses without plan headers and rejects a malformed number", () => {
    expect(readHeaders({ "content-type": "text/event-stream", "x-codex-turn-state": "x" })).toEqual(
      [],
    );
    expect(() => readHeaders({ "anthropic-ratelimit-unified-5h-utilization": "lots" })).toThrow(
      'Header anthropic-ratelimit-unified-5h-utilization is not a number: "lots"',
    );
  });
});

describe("readStreamEvent", () => {
  it("reads codex.rate_limits events and ignores other events", () => {
    expect(
      readStreamEvent({
        type: "codex.rate_limits",
        rate_limits: {
          primary: { used_percent: 100, window_minutes: 300, reset_at: 1794020000 },
          secondary: null,
        },
      }),
    ).toEqual({
      plan: "codex",
      source: "codex.rate_limits event",
      windows: { "5h": { utilization: 1, resetsAt: 1_794_020_000_000 } },
    });
    expect(readStreamEvent({ type: "response.completed" })).toBeUndefined();
    expect(() =>
      readStreamEvent({
        type: "codex.rate_limits",
        rate_limits: { primary: { used_percent: "x" } },
      }),
    ).toThrow(/Invalid codex.rate_limits event/);
  });
});

describe("plan files", () => {
  it("merges readings per window, keeps each window's seenAt, and leaves no temp file", async () => {
    const [claude] = readHeaders(bridgeHeaders);
    if (!claude) throw new Error("no Claude reading");
    await writeReading(home, claude, 1_000);
    await writeReading(
      home,
      { plan: "claude", source: "test", windows: { "5h": { utilization: 0.5 } } },
      2_000,
    );

    const stored = await readPlan(home, "claude");
    expect(stored).toMatchObject({
      plan: "claude",
      status: "allowed",
      seenAt: 2_000,
      windows: {
        "5h": { utilization: 0.5, seenAt: 2_000 },
        "7d": { utilization: 0.8, seenAt: 1_000 },
      },
    });
    expect(readdirSync(join(home, "usage"))).toEqual(["claude.json"]);
    expect(JSON.parse(readFileSync(join(home, "usage", "claude.json"), "utf8")).plan).toBe(
      "claude",
    );
    expect((await readPlans(home)).plans.map((plan) => plan.plan)).toEqual(["claude"]);
  });

  it("names the file when it is broken", async () => {
    mkdirSync(join(home, "usage"));
    writeFileSync(join(home, "usage", "codex.json"), JSON.stringify({ plan: "codex" }));
    await expect(readPlan(home, "codex")).rejects.toThrow(/codex\.json: .*windows/);
    const { plans, errors } = await readPlans(home);
    expect(plans).toEqual([]);
    expect(errors[0]).toMatch(/codex\.json/);
  });
});

describe("planState", () => {
  const options = { maxAgeMs: 3_600_000, weekly: 0.75, fiveHour: 1 };
  const snapshot = (
    windows: Record<string, { utilization: number; resetsAt?: number; seenAt: number }>,
  ) => ({
    plan: "claude",
    source: "test",
    seenAt: 0,
    windows,
  });

  it("is under pressure when the weekly window is above 75% or the 5-hour window is full", () => {
    const now = 10_000;
    expect(
      planState("claude", snapshot({ "7d": { utilization: 0.76, seenAt: now } }), now, options),
    ).toMatchObject({ room: "room", pressure: true });
    expect(
      planState("claude", snapshot({ "7d": { utilization: 0.75, seenAt: now } }), now, options)
        .pressure,
    ).toBe(false);
    expect(
      planState(
        "claude",
        snapshot({ "5h": { utilization: 1, resetsAt: 50_000, seenAt: now } }),
        now,
        options,
      ),
    ).toMatchObject({ room: "full", pressure: true, resetsAt: 50_000 });
  });

  it("ignores stale windows: too old, or past their reset", () => {
    const now = 10_000_000;
    const old = snapshot({ "5h": { utilization: 1, seenAt: now - 3_600_001 } });
    expect(planState("claude", old, now, options)).toMatchObject({
      room: "unknown",
      pressure: false,
    });
    const reset = snapshot({ "5h": { utilization: 1, resetsAt: now - 1, seenAt: now - 10 } });
    expect(windowViews(reset, now, options.maxAgeMs)[0]?.stale).toBe("reset since it was seen");
    expect(planState("claude", reset, now, options).room).toBe("unknown");
    expect(planState("codex", undefined, now, options)).toEqual({
      plan: "codex",
      room: "unknown",
      pressure: false,
      notes: ["codex: no usage seen"],
    });
  });
});
