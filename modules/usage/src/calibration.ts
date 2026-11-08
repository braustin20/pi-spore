import { QUESTIONS, type Question, type RoutingRecord } from "@pi-spore/router";
import type { CalibrationBar, CalibrationBucket, CalibrationResponse } from "@pi-spore/shared";

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

type Answers = Record<Question, number>;
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

  // A decision gets one entry per local outcome it is the newest decision for.
  const local: { decision: Decision; passed: boolean }[] = [];
  for (const outcome of outcomes) {
    let newest: Decision | undefined;
    for (const decision of decisions) {
      if (decision.record.agentId !== outcome.agentId || decision.record.at > outcome.endedAt)
        continue;
      if (!newest || decision.record.at > newest.record.at) newest = decision;
    }
    if (newest?.record.route !== "local") continue;
    const { sessionId } = newest.record;
    local.push({
      decision: newest,
      passed: outcome.verdict === "approve" && !(sessionId && escalated.has(sessionId)),
    });
  }

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
      const at = (decision: Decision): CalibrationBucket =>
        row[
          Math.min(BUCKETS - 1, Math.floor(decision.answers[question] * BUCKETS))
        ] as CalibrationBucket;
      for (const decision of decisions) at(decision).answers++;
      for (const entry of local) {
        const bucket = at(entry.decision);
        bucket.localOutcomes++;
        if (entry.passed) bucket.passed++;
      }
      for (const bucket of row) bucket.enough = bucket.localOutcomes >= MIN_SAMPLE;
      return [question, row];
    }),
  ) as CalibrationResponse["buckets"];

  const bars: CalibrationBar[] = Array.from({ length: BUCKETS - 1 }, (_, index) => {
    const bar = (index + 1) / BUCKETS;
    const clears = (decision: Decision) => QUESTION_NAMES.every((q) => decision.answers[q] >= bar);
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
    minSample: MIN_SAMPLE,
    decisions: decisions.length,
    outcomes: local.length,
    buckets,
    bars,
    ...(suggested ? { suggestedBar: suggested.bar } : {}),
    skipped,
  };
}
