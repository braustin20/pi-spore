import { GOOD, type JevAnswers, type Question } from "./jev.js";
import { type RouterSettings, splitModel, tierOf } from "./settings.js";
import type { PlanState } from "./usage.js";

export interface DecideInput {
  settings: RouterSettings;
  /** The cloud model for the role, `provider/id`. */
  cloud: string;
  /** The local target that would take the task, or why there is none. */
  local: { model: string; budget: number } | { missing: string };
  /** Token estimate of the task (brief, named files, conversation). Undefined when there is no local target. */
  estimate?: number;
  /** Good-answer probabilities, or why the classifier gave none. Undefined when it was not asked. */
  jev?: JevAnswers | { error: string };
  /** Usage state by plan name. */
  plans: Readonly<Record<string, PlanState>>;
  /** The `router.explore` draw came up: send the task local if "straightforward" is its only blocker (ADR 0144). */
  explore?: boolean;
}

export type Route = "local" | "cloud" | "spill" | "wait";

export interface Decision {
  route: Route;
  /** The model to send to, `provider/id`. Absent for `wait`. */
  model?: string;
  reasons: string[];
  /** Usage pressure on the cloud model's plan (R4.10). */
  pressure: boolean;
  /** The task went local only because of the explore draw (ADR 0144). */
  explore?: boolean;
  /** The confidence Jev's answers needed. */
  threshold: number;
  /** For `wait`: the first reset of a full window, epoch ms. */
  resetsAt?: number;
}

const planOf = (settings: RouterSettings, model: string): string | undefined =>
  settings.plans[splitModel(model).provider];

/**
 * Why the task cannot go local, one line each; empty means the local target can take it. `questions` names the Jev
 * questions among them.
 */
function localBlockers(
  input: DecideInput,
  threshold: number,
): { blockers: string[]; questions: Question[] } {
  const { local, estimate, jev, settings } = input;
  const other = (blocker: string) => ({ blockers: [blocker], questions: [] });
  if ("missing" in local) return other(local.missing);
  if (estimate === undefined) return other("no token estimate");
  if (estimate > local.budget) {
    return other(`estimate ${estimate} tokens is over the local budget of ${local.budget}`);
  }
  if (!jev) return other("classifier not asked");
  if ("error" in jev) return other(jev.error);
  const failed: string[] = [];
  const questions: Question[] = [];
  for (const question of Object.keys(GOOD) as Question[]) {
    // Pressure never relaxes the visual check (R4.10).
    const needed = question === "visual" ? settings.threshold : threshold;
    if (jev[question] < needed) {
      failed.push(`${question}: ${GOOD[question]} ${jev[question].toFixed(2)} < ${needed}`);
      questions.push(question);
    }
  }
  return { blockers: failed, questions };
}

/**
 * The cloud model, or a same-tier model on another plan when the cloud model's plan is full (ADR 0024). A plan with
 * no fresh numbers counts as having room, and the reason says so.
 */
export function cloudChoice(
  settings: RouterSettings,
  cloud: string,
  plans: Readonly<Record<string, PlanState>>,
): Omit<Decision, "pressure" | "threshold"> {
  const cloudPlan = planOf(settings, cloud);
  const cloudState = cloudPlan ? plans[cloudPlan] : undefined;
  if (cloudState?.room !== "full") return { route: "cloud", model: cloud, reasons: [] };

  const reasons = [`${cloudPlan} plan is full`];
  const tier = tierOf(settings, cloud);
  const spill = settings.spill.find((model) => {
    const plan = planOf(settings, model);
    return plan !== undefined && plan !== cloudPlan && tierOf(settings, model) === tier;
  });
  if (!spill) {
    return {
      route: "wait",
      reasons: [...reasons, `no ${tier} spill model on another plan`],
      ...(cloudState.resetsAt === undefined ? {} : { resetsAt: cloudState.resetsAt }),
    };
  }
  const spillPlan = planOf(settings, spill) as string;
  const spillState = plans[spillPlan];
  if (spillState?.room === "full") {
    const resets = [cloudState.resetsAt, spillState.resetsAt].filter(
      (at): at is number => at !== undefined,
    );
    return {
      route: "wait",
      reasons: [...reasons, `${spillPlan} plan is full too`],
      ...(resets.length > 0 ? { resetsAt: Math.min(...resets) } : {}),
    };
  }
  return {
    route: "spill",
    model: spill,
    reasons: [
      ...reasons,
      spillState?.room === "room"
        ? `spill to ${spill}`
        : `spill to ${spill}; ${spillPlan} usage unknown, treated as room`,
    ],
  };
}

/**
 * Routes a new task (ADR 0009, 0024): local when it fits the local budget and every good Jev answer reaches the
 * threshold (lower under usage pressure, except the visual one); otherwise the cloud model, or a spill model when the
 * cloud plan is full.
 */
export function decide(input: DecideInput): Decision {
  const { settings, cloud, plans } = input;
  const cloudPlan = planOf(settings, cloud);
  const pressure = cloudPlan !== undefined && plans[cloudPlan]?.pressure === true;
  const threshold = pressure ? settings.pressureThreshold : settings.threshold;
  const pressureNote = pressure ? [`${cloudPlan} usage pressure: threshold ${threshold}`] : [];

  const { blockers, questions } = localBlockers(input, threshold);
  if (
    input.explore &&
    questions.length === 1 &&
    questions[0] === "straightforward" &&
    !("missing" in input.local)
  ) {
    return {
      route: "local",
      model: input.local.model,
      reasons: [
        ...pressureNote,
        ...blockers,
        "explore: sent local to record an outcome (ADR 0144)",
      ],
      pressure,
      explore: true,
      threshold,
    };
  }
  if (blockers.length === 0 && !("missing" in input.local)) {
    return {
      route: "local",
      model: input.local.model,
      reasons: [...pressureNote, "bounded, explicit, non-visual, straightforward, and fits"],
      pressure,
      threshold,
    };
  }
  const choice = cloudChoice(settings, cloud, plans);
  return {
    ...choice,
    reasons: [...pressureNote, ...blockers, ...choice.reasons],
    pressure,
    threshold,
  };
}

/** Failures in a row on a local target before the session moves to the cloud model. */
export const MAX_LOCAL_FAILURES = 2;

/**
 * Whether a failed local request moves the session to the cloud (ADR 0009): at once on a context overflow, else on
 * the second failure in a row. A busy queue (`queue_wait_timeout`, spike Q3) is not a failure.
 */
export function escalation(
  failures: number,
  failed: { overflow: boolean; errorMessage?: string },
): { escalate: boolean; failures: number; reason?: string } {
  if (failed.overflow) return { escalate: true, failures, reason: "context overflow on local" };
  if (failed.errorMessage?.includes("queue_wait_timeout")) return { escalate: false, failures };
  const next = failures + 1;
  if (next >= MAX_LOCAL_FAILURES) {
    return {
      escalate: true,
      failures: next,
      reason: `failed ${next} times on local${failed.errorMessage ? `: ${failed.errorMessage}` : ""}`,
    };
  }
  return { escalate: false, failures: next };
}
