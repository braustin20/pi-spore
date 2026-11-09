import {
  CHEAP_QUESTIONS,
  HEAVY_QUESTIONS,
  QUESTIONS,
  type Question,
  type RoutingRecord,
} from "@pi-spore/router";
import type {
  CalibrationBar,
  CalibrationBucket,
  CalibrationResponse,
  CalibrationRung,
} from "@pi-spore/shared";

/** ADR 0144: under this many local outcomes a share says too little. */
export const MIN_SAMPLE = 20;
const MIN_PASS_SHARE = 0.9;
const BUCKETS = 10;

/** A finished pipeline run, as `usage_outcomes` stores it. Only runs with a reviewer verdict count. */
export interface Outcome {
  agentId: string;
  verdict: "approve" | "revise";
  endedAt: number;
}

// Lines from before ADR 0141 lack `foundational` and `design`.
type Answers = Partial<Record<Question, number>>;
interface Decision {
  record: RoutingRecord;
  answers: Answers;
}

const QUESTION_NAMES = Object.keys(QUESTIONS) as Question[];

function answersOf(record: RoutingRecord): Answers | undefined {
  const { jev } = record;
  return jev && !("error" in jev) ? jev : undefined;
}

/**
 * The report of ADR 0144: how Jev's answers spread, and how local runs that followed them turned out. A local run
 * passed when its reviewer approved and its session never escalated to the cloud model.
 */
export function calibration(
  records: readonly RoutingRecord[],
  outcomes: readonly Outcome[],
  threshold: number,
  heavyThreshold: number,
  skipped: number,
): CalibrationResponse {
  const decisions: Decision[] = records.flatMap((record) => {
    const answers = record.kind === "initial" ? answersOf(record) : undefined;
    return answers ? [{ record, answers }] : [];
  });
  const escalated = new Set(
    records.flatMap((record) =>
      record.kind === "escalation" && record.sessionId ? [record.sessionId] : [],
    ),
  );

  const passedOf = (outcome: Outcome, { sessionId }: RoutingRecord) =>
    outcome.verdict === "approve" && !(sessionId && escalated.has(sessionId));
  const newestBefore = <T extends { record: RoutingRecord }>(
    candidates: readonly T[],
    outcome: Outcome,
  ): T | undefined => {
    let newest: T | undefined;
    for (const candidate of candidates) {
      const { agentId, at } = candidate.record;
      if (agentId !== outcome.agentId || at > outcome.endedAt) continue;
      if (!newest || at > newest.record.at) newest = candidate;
    }
    return newest;
  };

  // A decision gets one entry per local outcome it is the newest decision for.
  const local: { decision: Decision; passed: boolean }[] = [];
  for (const outcome of outcomes) {
    const newest = newestBefore(decisions, outcome);
    if (newest?.record.route !== "local") continue;
    local.push({ decision: newest, passed: passedOf(outcome, newest.record) });
  }

  // Rung decisions need no Jev answers: an error sends the task to rung 3 without any.
  const rungDecisions = records.flatMap((record) =>
    record.kind === "initial" && record.rung !== undefined ? [{ record, rung: record.rung }] : [],
  );
  const rows = new Map<string, CalibrationRung>();
  const rowOf = ({ record, rung }: (typeof rungDecisions)[number]): CalibrationRung => {
    const place = record.route === "local" ? "local" : (record.plan ?? record.route);
    const key = `${rung}/${place}`;
    let row = rows.get(key);
    if (!row) {
      row = { rung, place, decisions: 0, outcomes: 0, passed: 0 };
      rows.set(key, row);
    }
    return row;
  };
  for (const entry of rungDecisions) rowOf(entry).decisions++;
  for (const outcome of outcomes) {
    const newest = newestBefore(rungDecisions, outcome);
    if (!newest) continue;
    const row = rowOf(newest);
    row.outcomes++;
    if (passedOf(outcome, newest.record)) row.passed++;
  }
  const rungs = [...rows.values()].sort(
    (a, b) => a.rung - b.rung || a.place.localeCompare(b.place),
  );

  const buckets = Object.fromEntries(
    QUESTION_NAMES.map((question) => {
      const row: CalibrationBucket[] = Array.from({ length: BUCKETS }, (_, index) => ({
        from: index / BUCKETS,
        to: (index + 1) / BUCKETS,
        answers: 0,
        localOutcomes: 0,
        passed: 0,
        enough: false,
      }));
      const at = (answer: number): CalibrationBucket =>
        row[Math.min(BUCKETS - 1, Math.floor(answer * BUCKETS))] as CalibrationBucket;
      for (const decision of decisions) {
        const answer = decision.answers[question];
        if (answer !== undefined) at(answer).answers++;
      }
      for (const entry of local) {
        const answer = entry.decision.answers[question];
        if (answer === undefined) continue;
        const bucket = at(answer);
        bucket.localOutcomes++;
        if (entry.passed) bucket.passed++;
      }
      for (const bucket of row) bucket.enough = bucket.localOutcomes >= MIN_SAMPLE;
      return [question, row];
    }),
  ) as CalibrationResponse["buckets"];

  const bars: CalibrationBar[] = Array.from({ length: BUCKETS - 1 }, (_, index) => {
    const bar = (index + 1) / BUCKETS;
    const clears = ({ answers }: Decision) =>
      CHEAP_QUESTIONS.every((q) => (answers[q] as number) >= bar) &&
      HEAVY_QUESTIONS.every((q) => (answers[q] ?? 1) >= heavyThreshold);
    const taken = local.filter((entry) => clears(entry.decision));
    return {
      bar,
      decisions: decisions.length,
      wouldGoLocal: decisions.filter(clears).length,
      localOutcomes: taken.length,
      passed: taken.filter((entry) => entry.passed).length,
      enough: taken.length >= MIN_SAMPLE,
    };
  });
  const suggested = bars.find(
    (row) => row.enough && row.passed / row.localOutcomes >= MIN_PASS_SHARE,
  );

  return {
    threshold,
    heavyThreshold,
    minSample: MIN_SAMPLE,
    decisions: decisions.length,
    outcomes: local.length,
    buckets,
    bars,
    rungs,
    ...(suggested ? { suggestedBar: suggested.bar } : {}),
    skipped,
  };
}
