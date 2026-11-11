import { CHEAP_QUESTIONS, GOOD, HEAVY_QUESTIONS, type JevAnswers, type Question } from "./jev.js";
import type { LadderEntry, RouterSettings, ThinkingLevel } from "./settings.js";
import type { PlanState } from "./usage.js";

export interface DecideInput {
  settings: RouterSettings;
  /** The local target that would take the task, or why there is none. */
  local:
    | {
        model: string;
        budget: number;
        thinking: ThinkingLevel;
        /** Sessions using the target's slots, and sessions waiting for one (ADR 0141). */
        queue: { busy: boolean; waiting: number };
      }
    | { missing: string };
  /** Token estimate of the task (brief, named files, conversation). */
  estimate: number;
  /** Good-answer probabilities, or why the classifier gave none. Undefined when it was not asked. */
  jev?: JevAnswers | { error: string };
  /** Usage state by plan name. */
  plans: Readonly<Record<string, PlanState>>;
  /**
   * The `router.explore` draw came up: send the task local when its only blocker is "straightforward" or "visual"
   * (ADR 0144, 0173).
   */
  explore?: boolean;
}

export type Rung = 1 | 2 | 3;
export type Route = "local" | "cloud" | "wait";

export interface Decision {
  route: Route;
  rung: Rung;
  /** The ladder plan whose usage the task draws on. Absent for `wait`, and for local when every plan is full. */
  plan?: string;
  /** The model to send to, `provider/id`. Absent for `wait`. */
  model?: string;
  /** The thinking level the router uses for the model. Absent for `wait`. */
  thinking?: ThinkingLevel;
  reasons: string[];
  /** Usage pressure on the first plan that is not full (R4.10). */
  pressure: boolean;
  /** The task went local only because of the explore draw (ADR 0144). */
  explore?: boolean;
  /** The confidence the cheap Jev answers needed. */
  threshold: number;
  /** For `wait`: the first reset of a full window, epoch ms. */
  resetsAt?: number;
}

/** The first ladder plan that is not full. A plan with no fresh numbers counts as having room. */
const openPlan = (
  settings: RouterSettings,
  plans: Readonly<Record<string, PlanState>>,
): string | undefined =>
  settings.ladders.find((ladder) => plans[ladder.plan]?.room !== "full")?.plan;

/**
 * The rung's model on the first plan that is not full (ADR 0141), or `wait` when every plan is full. Also used to
 * move a session up a rung.
 */
export function ladderChoice(
  settings: RouterSettings,
  rung: Rung,
  plans: Readonly<Record<string, PlanState>>,
): Pick<Decision, "route" | "plan" | "model" | "thinking" | "reasons" | "resetsAt"> {
  const reasons: string[] = [];
  const resets: number[] = [];
  for (const { plan, rungs } of settings.ladders) {
    const state = plans[plan];
    if (state?.room === "full") {
      reasons.push(`${plan} plan is full`);
      if (state.resetsAt !== undefined) resets.push(state.resetsAt);
      continue;
    }
    if (state?.room !== "room") reasons.push(`${plan} usage unknown, treated as room`);
    const { model, thinking } = rungs[rung - 1] as LadderEntry;
    return { route: "cloud", plan, model, thinking, reasons };
  }
  return {
    route: "wait",
    reasons: [...reasons, "every plan is full"],
    ...(resets.length > 0 ? { resetsAt: Math.min(...resets) } : {}),
  };
}

const probability = (question: Question, answers: JevAnswers, bar: number): string =>
  `${question}: ${GOOD[question]} ${answers[question].toFixed(2)} < ${bar}`;

/**
 * The rung the task needs, why, every question it failed, heavy ones first, and whether the estimate is over
 * `router.large`. The failed questions and the size are what explore weighs (ADR 0144, 0173).
 */
function rungFor(
  input: DecideInput,
  threshold: number,
): { rung: Rung; why: string[]; failed: Question[]; large: boolean } {
  const { settings, jev, estimate } = input;
  const large = estimate > settings.large;
  if (!jev) return { rung: 3, why: ["classifier not asked"], failed: [], large };
  if ("error" in jev) return { rung: 3, why: [jev.error], failed: [], large };
  const heavyFailed = HEAVY_QUESTIONS.filter((question) => jev[question] < settings.heavyThreshold);
  const cheapFailed = CHEAP_QUESTIONS.filter((question) => jev[question] < threshold);
  const failed = [...heavyFailed, ...cheapFailed];
  if (heavyFailed.length > 0 || large) {
    const why = heavyFailed.map((question) => probability(question, jev, settings.heavyThreshold));
    if (large) why.push(`estimate ${estimate} tokens is over router.large ${settings.large}`);
    return { rung: 3, why, failed, large };
  }
  if (cheapFailed.length === 0) {
    return {
      rung: 1,
      why: [`${CHEAP_QUESTIONS.join(", ")} reach ${threshold}`],
      failed,
      large,
    };
  }
  return {
    rung: 2,
    why: cheapFailed.map((question) => probability(question, jev, threshold)),
    failed,
    large,
  };
}

/** Why the local target cannot take the task now; undefined when it can. */
function localBlock({ local, estimate, settings }: DecideInput): string | undefined {
  if ("missing" in local) return local.missing;
  if (estimate > local.budget) {
    return `estimate ${estimate} tokens is over the local budget of ${local.budget}`;
  }
  if (local.queue.busy && local.queue.waiting >= settings.maxQueued) {
    return `queue for ${local.model} is ${local.queue.waiting}; router.maxQueued is ${settings.maxQueued}`;
  }
  return undefined;
}

/**
 * Routes a new task (ADR 0009, 0141): picks a rung from the Jev answers and the size, then the first plan that is
 * not full. Rung 1 goes to the local target when it can take the task. Usage pressure lowers the cheap bar only.
 */
export function decide(input: DecideInput): Decision {
  const { settings, local, plans } = input;
  const plan = openPlan(settings, plans);
  const pressure = plan !== undefined && plans[plan]?.pressure === true;
  const threshold = pressure ? settings.pressureThreshold : settings.threshold;
  const pressureNote = pressure ? [`${plan} usage pressure: threshold ${threshold}`] : [];

  const picked = rungFor(input, threshold);
  const explore =
    input.explore === true &&
    picked.failed.length === 1 &&
    (picked.failed[0] === "straightforward" || picked.failed[0] === "visual") &&
    !picked.large &&
    localBlock(input) === undefined;
  const rung: Rung = explore ? 1 : picked.rung;
  const rungReasons = picked.why.map((why) => `rung ${rung}: ${why}`);
  const base = { rung, pressure, threshold };

  let notLocal: string[] = [];
  if (rung === 1) {
    const block = localBlock(input);
    if (block === undefined && !("missing" in local)) {
      return {
        route: "local",
        ...base,
        ...(plan === undefined ? {} : { plan }),
        model: local.model,
        thinking: local.thinking,
        reasons: [
          ...rungReasons,
          ...pressureNote,
          ...(explore ? ["explore: sent local to record an outcome (ADR 0144)"] : []),
        ],
        ...(explore ? { explore: true } : {}),
      };
    }
    notLocal = [block as string];
  }
  const choice = ladderChoice(settings, rung, plans);
  return {
    ...choice,
    ...base,
    reasons: [...rungReasons, ...pressureNote, ...notLocal, ...choice.reasons],
  };
}

/** Failures in a row on a local target before the session moves to the cloud model. */
export const MAX_LOCAL_FAILURES = 2;

/**
 * Whether a failed request moves the session up one rung (ADR 0009, 0141): at once on a context overflow, else on
 * the second failure in a row. A busy queue (`queue_wait_timeout`, spike Q3) is not a failure.
 */
export function escalation(
  failures: number,
  failed: { overflow: boolean; errorMessage?: string },
): { escalate: boolean; failures: number; reason?: string } {
  if (failed.overflow) return { escalate: true, failures, reason: "context overflow" };
  if (failed.errorMessage?.includes("queue_wait_timeout")) return { escalate: false, failures };
  const next = failures + 1;
  if (next >= MAX_LOCAL_FAILURES) {
    return {
      escalate: true,
      failures: next,
      reason: `failed ${next} times in a row${failed.errorMessage ? `: ${failed.errorMessage}` : ""}`,
    };
  }
  return { escalate: false, failures: next };
}
