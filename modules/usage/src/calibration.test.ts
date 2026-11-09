import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectsModule } from "@pi-spore/mod-projects/server";
import { workspacesModule } from "@pi-spore/mod-workspaces/server";
import { createTestServer, type TestServer } from "@pi-spore/server-core/testing";
import { CalibrationResponse, parse } from "@pi-spore/shared";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAttention } from "./fake-attention.js";
import { type FakeRun, fakePipelines } from "./fake-pipelines.js";
import { createUsageModule } from "./server.js";

let server: TestServer | undefined;
let end: (run: FakeRun) => void;
afterEach(() => server?.close());

const ANSWERS = ["bounded", "explicit", "visual", "straightforward"] as const;
type Answers = Record<(typeof ANSWERS)[number], number>;
const all = (p: number): Answers => ({ bounded: p, explicit: p, visual: p, straightforward: p });

async function start(records: object[]): Promise<void> {
  const pipelines = fakePipelines();
  end = pipelines.end;
  server = await createTestServer(
    [pipelines.module, fakeAttention, projectsModule, workspacesModule, createUsageModule()],
    {},
  );
  mkdirSync(join(server.paths.root, "usage"), { recursive: true });
  writeFileSync(
    join(server.paths.root, "usage", "routing.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

const decision = (agentId: string, route: "local" | "cloud", jev: Answers, at = 1000) => ({
  at,
  kind: "initial",
  route,
  reasons: [],
  agentId,
  sessionId: `session-${agentId}`,
  jev,
});
const escalation = (agentId: string) => ({
  at: 1500,
  kind: "escalation",
  route: "cloud",
  reasons: [],
  agentId,
  sessionId: `session-${agentId}`,
});
const finish = (agentId: string, verdict: "approve" | "revise", endedAt = 2000): void =>
  end({ id: `run-${agentId}`, agentId, endedAt, turns: [{ kind: "review", verdict }] });

async function report(): Promise<CalibrationResponse> {
  const response = await (server as TestServer).request("GET", "/api/usage/calibration");
  expect(response.status).toBe(200);
  return parse(CalibrationResponse, await response.json(), "calibration");
}

const ids = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe("GET /api/usage/calibration", () => {
  /**
   * 25 local runs with every answer 0.8 (L0..L24; L3..L6 escalated, so 21 passed), 5 local runs with
   * "straightforward" 0.45 and the rest 0.9 (M0 and M1 approved), 3 cloud runs with every answer 0.9, one local
   * decision after its run ended, and a classifier error. That is 34 decisions and 30 local outcomes.
   */
  async function mixed(): Promise<CalibrationResponse> {
    const l = ids("L", 25);
    const m = ids("M", 5);
    const c = ids("C", 3);
    await start([
      ...l.map((id) => decision(id, "local", all(0.8))),
      ...m.map((id) => decision(id, "local", { ...all(0.9), straightforward: 0.45 })),
      ...c.map((id) => decision(id, "cloud", all(0.9))),
      decision("late", "local", all(0.8), 3000),
      {
        at: 1000,
        kind: "initial",
        route: "cloud",
        reasons: [],
        agentId: "broken",
        jev: { error: "x" },
      },
      ...["L3", "L4", "L5", "L6"].map(escalation),
    ]);
    for (const id of l) finish(id, "approve");
    for (const id of m) finish(id, id === "M0" || id === "M1" ? "approve" : "revise");
    for (const id of c) finish(id, "approve");
    finish("late", "approve");
    finish("broken", "approve");
    return report();
  }

  it("counts decisions and local outcomes, not cloud runs or decisions after the run ended", async () => {
    const body = await mixed();
    expect(body).toMatchObject({
      threshold: 0.7,
      minSample: 20,
      decisions: 34,
      outcomes: 30,
      skipped: 0,
    });
  });

  it("buckets each question, and marks a bucket under 20 local outcomes as not enough", async () => {
    const { buckets } = await mixed();
    for (const question of ["bounded", "explicit", "visual"] as const) {
      expect(buckets[question]).toHaveLength(10);
      // L and "late" answer 0.8; M and C answer 0.9.
      expect(buckets[question][8]).toEqual({
        from: 0.8,
        to: 0.9,
        answers: 26,
        localOutcomes: 25,
        passed: 21,
        enough: true,
      });
      expect(buckets[question][9]).toMatchObject({
        answers: 8,
        localOutcomes: 5,
        passed: 2,
        enough: false,
      });
    }
    expect(buckets.straightforward[4]).toMatchObject({
      answers: 5,
      localOutcomes: 5,
      passed: 2,
      enough: false,
    });
    expect(buckets.straightforward[9]).toMatchObject({ answers: 3, localOutcomes: 0 });
  });

  it("counts what each bar would send local and how those runs ended", async () => {
    const { bars, suggestedBar } = await mixed();
    expect(bars.map((row) => row.bar)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    // Every decision clears 0.4. M's 0.45 does not clear 0.5, so L, "late" and C do: 29.
    expect(bars[3]).toEqual({
      bar: 0.4,
      decisions: 34,
      wouldGoLocal: 34,
      localOutcomes: 30,
      passed: 23,
      enough: true,
    });
    expect(bars[4]).toEqual({
      bar: 0.5,
      decisions: 34,
      wouldGoLocal: 29,
      localOutcomes: 25,
      passed: 21,
      enough: true,
    });
    // Only the three cloud decisions have every answer at 0.9.
    expect(bars[8]).toMatchObject({ wouldGoLocal: 3, localOutcomes: 0, passed: 0, enough: false });
    // 23 of 30 and 21 of 25 are both under 90%.
    expect(suggestedBar).toBeUndefined();
  });

  it("does not count an escalated local run as passed", async () => {
    await start([decision("a", "local", all(0.8)), escalation("a")]);
    finish("a", "approve");
    const body = await report();
    expect(body.outcomes).toBe(1);
    expect(body.bars[0]).toMatchObject({ localOutcomes: 1, passed: 0 });
  });

  it("joins an outcome to the newest decision of its agent before the run ended", async () => {
    await start([
      decision("a", "local", all(0.2), 500),
      decision("a", "cloud", all(0.4), 900),
      decision("a", "local", all(0.8), 1000),
      decision("a", "cloud", all(0.9), 2500),
    ]);
    finish("a", "approve");
    const body = await report();
    expect(body.outcomes).toBe(1);
    expect(body.buckets.bounded[8]).toMatchObject({ answers: 1, localOutcomes: 1, passed: 1 });
    expect(body.buckets.bounded[2]).toMatchObject({ answers: 1, localOutcomes: 0 });
  });

  it("suggests the lowest bar with 20 local outcomes and 90% passed", async () => {
    const agents = ids("A", 20);
    await start(agents.map((id) => decision(id, "local", all(0.8))));
    for (const id of agents) finish(id, "approve");
    const body = await report();
    expect(body.suggestedBar).toBe(0.1);
    expect(body.bars[8]?.enough).toBe(false);
  });

  it("suggests nothing under 20 local outcomes, even when every one passed", async () => {
    const agents = ids("A", 19);
    await start(agents.map((id) => decision(id, "local", all(0.8))));
    for (const id of agents) finish(id, "approve");
    const body = await report();
    expect(body.suggestedBar).toBeUndefined();
    expect(body.bars[0]).toMatchObject({ localOutcomes: 19, passed: 19, enough: false });
  });

  it("suggests the lowest bar that clears 90%, skipping lower bars that fail", async () => {
    // 20 runs at 0.8 pass. 5 runs at 0.3 fail and join every bar up to 0.3, which drops those under 90%.
    const good = ids("G", 20);
    const poor = ids("P", 5);
    await start([
      ...good.map((id) => decision(id, "local", all(0.8))),
      ...poor.map((id) => decision(id, "local", all(0.3))),
    ]);
    for (const id of good) finish(id, "approve");
    for (const id of poor) finish(id, "revise");
    const body = await report();
    expect(body.bars[2]).toMatchObject({ localOutcomes: 25, passed: 20 });
    expect(body.suggestedBar).toBe(0.4);
  });

  it("answers 422 when the router settings are bad", async () => {
    await start([]);
    writeFileSync(join((server as TestServer).paths.root, "settings.json"), "{ not json");
    const response = await (server as TestServer).request("GET", "/api/usage/calibration");
    expect(response.status).toBe(422);
  });
});

describe("usage_outcomes", () => {
  const rows = () =>
    (server as TestServer).store.all<{
      run_id: string;
      workspace_id: string;
      agent_id: string;
      state: string;
      verdict: string | null;
      review_rounds: number;
      fix_passes: number;
      ended_at: number;
    }>("SELECT * FROM usage_outcomes ORDER BY run_id");

  it("stores the last review of the first reviewer stage, with its rounds and fix passes", async () => {
    await start([]);
    end({
      id: "r1",
      agentId: "a",
      state: "failed",
      endedAt: 2000,
      turns: [
        { kind: "task", stageIndex: 0 },
        { kind: "review", stageIndex: 1, verdict: "revise" },
        { kind: "fix", stageIndex: 1 },
        { kind: "review", stageIndex: 1, verdict: "approve" },
        { kind: "review", stageIndex: 2, verdict: "revise" },
      ],
    });
    expect(rows()).toEqual([
      {
        run_id: "r1",
        workspace_id: "ws",
        agent_id: "a",
        state: "failed",
        verdict: "approve",
        review_rounds: 3,
        fix_passes: 1,
        ended_at: 2000,
      },
    ]);
  });

  it("stores no verdict for a run without a review, skips a run without a worker, and replaces by run id", async () => {
    await start([]);
    end({ id: "r1", agentId: "a", endedAt: 2000, turns: [{ kind: "task" }] });
    end({ id: "r2", endedAt: 2000, turns: [{ kind: "review", verdict: "approve" }] });
    expect(rows().map((row) => [row.run_id, row.verdict, row.review_rounds])).toEqual([
      ["r1", null, 0],
    ]);
    end({ id: "r1", agentId: "a", endedAt: 3000, turns: [{ kind: "review", verdict: "revise" }] });
    expect(rows().map((row) => [row.run_id, row.verdict, row.ended_at])).toEqual([
      ["r1", "revise", 3000],
    ]);
  });
});
