import {
  type Api,
  type AssistantMessage,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import {
  type DecideInput,
  type Decision,
  decide,
  escalation,
  ladderChoice,
  type Route,
  type Rung,
} from "./decide.js";
import { contentText, estimateTokens } from "./estimate.js";
import { type JevAnswers, MAX_PROMPT_CHARS, QUESTIONS, readAnswers } from "./jev.js";
import type { LocalLocks } from "./lock.js";
import { appendRecord, type RoutingRecord } from "./records.js";
import {
  type LadderEntry,
  type LocalTarget,
  loadSettings,
  type RouterSettings,
  splitModel,
  type ThinkingLevel,
} from "./settings.js";
import {
  type PlanState,
  planState,
  readHeaders,
  readPlan,
  readStreamEvent,
  writeReading,
} from "./usage.js";

/** Router state on the session branch (Pi stores it as a `pi.virtual-model-state` entry). */
export interface RouterState {
  route: Exclude<Route, "wait">;
  rung: Rung;
  /** The ladder plan the session draws on. Absent for a local session when every plan was full. */
  plan?: string;
  /** `provider/id` the session is pinned to. */
  model: string;
  /** The level the router uses for the model, not the one the user picked for `spore/auto`. */
  thinking: ThinkingLevel;
  /** Failed requests in a row on the model. */
  failures: number;
  decidedAt: number;
  reasons: string[];
}

export type RouterRequest = ModelRouteRequest<RouterState>;

/** Thrown when no plan has room: Pi ends the request with this message (ADR 0024: the task waits for a reset). */
export class NoRoomError extends Error {
  override name = "NoRoomError";
}

/** A setting is wrong. Pi ends the request with its message; the router does not fall back (ADR 0141). */
export class RouterConfigError extends Error {
  override name = "RouterConfigError";
}

export interface RouterDeps {
  /** pi-spore's home folder (`~/.pi-spore`). */
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  now(): number;
  /** A draw in [0, 1) for `router.explore`. */
  random(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** The lock files; throws when they cannot exist (no `XDG_RUNTIME_DIR`). */
  locks(): LocalLocks;
  /** Whether a target answers on its health URL. */
  healthy(url: string, signal?: AbortSignal): Promise<boolean>;
  /** Tells other extensions a request goes to a local provider; returns the promises they asked the router to await. */
  announceLocal(
    target: { provider: string; modelId: string },
    ctx: ExtensionContext,
  ): Promise<unknown>[];
  isOverflow(message: AssistantMessage, contextWindow?: number): boolean;
}

/** How long to wait between looks at a busy local target's lock. */
const LOCK_POLL_MS = 1_000;
const STATUS_KEY = "pi-spore-router";

function lastUserText(messages: RouterRequest["messages"]): string {
  const message = messages.filter((candidate) => candidate.role === "user").at(-1);
  return message ? contentText(message.content) : "";
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The first ladder's entry on a rung: where direct requests and the router's own errors go. */
function firstLadderEntry(
  settings: RouterSettings,
  rung: Rung,
): { plan: string; entry: LadderEntry } {
  const { plan, rungs } = settings.ladders[0] as RouterSettings["ladders"][number];
  return { plan, entry: rungs[rung - 1] as LadderEntry };
}

/** The fields of a decision that every routing record carries. */
function decisionFields(decision: Decision) {
  return {
    route: decision.route,
    rung: decision.rung,
    ...(decision.plan ? { plan: decision.plan } : {}),
    ...(decision.model ? { model: decision.model } : {}),
    ...(decision.thinking ? { thinking: decision.thinking } : {}),
    reasons: decision.reasons,
    ...(decision.resetsAt !== undefined ? { resetsAt: decision.resetsAt } : {}),
  };
}

/**
 * Checks every ladder entry and local target against Pi's catalog on each request (ADR 0141): a model that is
 * missing, or a thinking level it does not take, ends the request. A local target missing from the catalog stays
 * allowed: the router then sends the task up the ladder.
 */
function checkCatalog(settings: RouterSettings, ctx: ExtensionContext): void {
  const lookup = (ref: string): Model<Api> | undefined => {
    const { provider, id } = splitModel(ref);
    return ctx.modelRegistry.find(provider, id);
  };
  const checkThinking = (setting: string, ref: string, level: ThinkingLevel, model: Model<Api>) => {
    const levels = getSupportedThinkingLevels(model);
    if (!levels.includes(level)) {
      throw new RouterConfigError(
        `${setting}.thinking ${level}: ${ref} takes ${levels.join(", ")}`,
      );
    }
  };
  settings.ladders.forEach((ladder, i) => {
    ladder.rungs.forEach((entry, j) => {
      const setting = `router.ladders[${i}].rungs[${j}]`;
      const model = lookup(entry.model);
      if (!model) {
        throw new RouterConfigError(`${setting}.model ${entry.model} is not in Pi's model catalog`);
      }
      checkThinking(setting, entry.model, entry.thinking, model);
    });
  });
  settings.localTargets.forEach((target, i) => {
    const model = lookup(target.model);
    if (model) checkThinking(`router.localTargets[${i}]`, target.model, target.thinking, model);
  });
}

/**
 * The `spore/auto` router (ADR 0009, 0010, 0141) and the usage tap (ADR 0022). One instance per Pi process. It holds
 * the local slots this process took, released when the agent run settles or the session shuts down.
 */
export class Router {
  private readonly held = new Map<string, string>();

  constructor(private readonly deps: RouterDeps) {}

  async route(request: RouterRequest, ctx: ExtensionContext): Promise<ModelRoute<RouterState>> {
    // Settings errors end the request: there is no ladder to fall back to (ADR 0141).
    const settings = await loadSettings(this.deps.home);
    checkCatalog(settings, ctx);
    try {
      return await this.routeOrThrow(request, ctx, settings);
    } catch (error) {
      if (error instanceof NoRoomError || request.signal?.aborted) throw error;
      return this.fallBack(request, ctx, settings, error);
    }
  }

  /** Records plan windows from a provider response's headers. */
  async onResponse(headers: Readonly<Record<string, string>>): Promise<void> {
    for (const reading of readHeaders(headers)) {
      await writeReading(this.deps.home, reading, this.deps.now());
    }
  }

  /** Records plan windows from a provider stream event (Codex over WebSocket, spike Q11). */
  async onStreamEvent(data: unknown): Promise<void> {
    const reading = readStreamEvent(data);
    if (reading) await writeReading(this.deps.home, reading, this.deps.now());
  }

  /** Frees this process's local slots: the run is over, so another session may use the target (ADR 0010). */
  async releaseAll(): Promise<void> {
    const paths = [...this.held.values()];
    this.held.clear();
    if (paths.length === 0) return;
    const locks = this.deps.locks();
    await Promise.all(paths.map((path) => locks.release(path)));
  }

  private async routeOrThrow(
    request: RouterRequest,
    ctx: ExtensionContext,
    settings: RouterSettings,
  ): Promise<ModelRoute<RouterState>> {
    // A state from before ADR 0141 has no rung: decide again once.
    const state = request.state?.rung === undefined ? undefined : request.state;

    if (request.reason === "direct") {
      // Compaction summaries and other side requests: stay on the model that answered last.
      const first = firstLadderEntry(settings, 1).entry;
      if (!request.previous)
        return { model: this.find(ctx, first.model), thinkingLevel: first.thinking };
      return {
        model: request.previous.model,
        thinkingLevel: request.previous.thinkingLevel ?? state?.thinking ?? first.thinking,
      };
    }
    if (!state) return this.decideNew(request, ctx, settings);

    const target =
      state.route === "local"
        ? settings.localTargets.find((candidate) => candidate.model === state.model)
        : undefined;
    if (state.route === "local" && !target) {
      return this.escalate(ctx, settings, state, `${state.model} is no longer a local target`);
    }
    let next: RouterState = state;
    // Rung 3 has nowhere to go: its failures pass through.
    if (request.reason === "retry" && request.failed && state.rung < 3) {
      const failed = request.failed.message;
      const contextWindow = target?.contextWindow ?? this.find(ctx, state.model).contextWindow;
      const verdict = escalation(state.failures, {
        overflow: this.deps.isOverflow(failed, contextWindow),
        ...(failed.errorMessage ? { errorMessage: failed.errorMessage } : {}),
      });
      if (verdict.escalate) {
        return this.escalate(ctx, settings, state, verdict.reason ?? "failed on the model");
      }
      if (verdict.failures !== state.failures) next = { ...state, failures: verdict.failures };
    } else if (state.failures > 0) {
      next = { ...state, failures: 0 };
    }
    if (target) {
      try {
        await this.holdLocal(target, ctx, request.signal);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        return this.escalate(ctx, settings, state, `local target not ready: ${errorText(error)}`);
      }
    }
    return {
      model: this.find(ctx, state.model),
      thinkingLevel: state.thinking,
      ...(next === state ? {} : { state: next }),
    };
  }

  private async decideNew(
    request: RouterRequest,
    ctx: ExtensionContext,
    settings: RouterSettings,
  ): Promise<ModelRoute<RouterState>> {
    const plans = await this.planStates(settings);
    const brief = lastUserText(request.messages);
    const target = settings.localTargets.find((candidate) => {
      const { provider, id } = splitModel(candidate.model);
      return ctx.modelRegistry.find(provider, id) !== undefined;
    });

    const estimate = await estimateTokens(ctx.getSystemPrompt(), request.messages, brief, ctx.cwd);
    const jev = await this.classify(settings, brief, ctx, request.signal);
    let budget: number | undefined;
    let local: DecideInput["local"] = { missing: "no local target in the catalog" };
    if (target) {
      budget = Math.floor(target.contextWindow * target.budget);
      try {
        const queue = await this.deps.locks().queue(target.model, target.concurrency);
        local = { model: target.model, budget, thinking: target.thinking, queue };
      } catch (error) {
        local = { missing: errorText(error) };
      }
    }

    let decision = decide({
      settings,
      local,
      estimate: estimate.total,
      jev,
      plans,
      // Only a worker stage explores: a stronger reviewer checks its work (ADR 0144).
      explore:
        this.deps.env.PI_SPORE_STAGE_ROLE === "worker" && this.deps.random() < settings.explore,
    });
    if (decision.route === "local" && target) {
      try {
        await this.holdLocal(target, ctx, request.signal);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const choice = ladderChoice(settings, 1, plans);
        decision = {
          ...choice,
          rung: 1,
          pressure: decision.pressure,
          threshold: decision.threshold,
          reasons: [
            ...decision.reasons,
            `local target not ready: ${errorText(error)}`,
            ...choice.reasons,
          ],
        };
      }
    }

    await this.record(ctx, {
      at: this.deps.now(),
      kind: "initial",
      ...decisionFields(decision),
      estimate: estimate.total,
      ...(budget !== undefined ? { budget } : {}),
      jev,
      threshold: decision.threshold,
      heavyThreshold: settings.heavyThreshold,
      pressure: decision.pressure,
      ...(decision.explore ? { explore: true } : {}),
      usage: Object.values(plans).flatMap((plan) => plan.notes),
    });
    return this.finish(ctx, decision);
  }

  /** Moves a session up one rung, on the first plan with room, and records why. */
  private async escalate(
    ctx: ExtensionContext,
    settings: RouterSettings,
    state: RouterState,
    reason: string,
  ): Promise<ModelRoute<RouterState>> {
    await this.releaseTarget(state.model);
    const plans = await this.planStates(settings);
    const rung = (state.rung + 1) as Rung;
    const choice = ladderChoice(settings, rung, plans);
    const decision: Decision = {
      ...choice,
      rung,
      reasons: [reason, ...choice.reasons],
      pressure: false,
      threshold: settings.threshold,
    };
    await this.record(ctx, {
      at: this.deps.now(),
      kind: "escalation",
      ...decisionFields(decision),
      usage: Object.values(plans).flatMap((plan) => plan.notes),
    });
    return this.finish(ctx, decision);
  }

  private finish(ctx: ExtensionContext, decision: Decision): ModelRoute<RouterState> {
    const { model, thinking } = decision;
    if (decision.route === "wait" || !model || !thinking) {
      const when = decision.resetsAt ? ` until ${new Date(decision.resetsAt).toISOString()}` : "";
      throw new NoRoomError(`No plan has room${when}: ${decision.reasons.join("; ")}`);
    }
    const label = decision.route === "local" ? "local" : decision.plan;
    ctx.ui.notify(
      `spore/auto: rung ${decision.rung} ${label} → ${model} (${thinking}) (${decision.reasons.join("; ")})`,
      "info",
    );
    return {
      model: this.find(ctx, model),
      thinkingLevel: thinking,
      state: {
        route: decision.route,
        rung: decision.rung,
        ...(decision.plan ? { plan: decision.plan } : {}),
        model,
        thinking,
        failures: 0,
        decidedAt: this.deps.now(),
        reasons: decision.reasons,
      },
    };
  }

  /** The router's own failure: send the request to the first ladder's rung 3, pin the session there, and record why. */
  private async fallBack(
    request: RouterRequest,
    ctx: ExtensionContext,
    settings: RouterSettings,
    error: unknown,
  ): Promise<ModelRoute<RouterState>> {
    const { plan, entry } = firstLadderEntry(settings, 3);
    const reasons = [`router error: ${errorText(error)}`];
    await this.record(ctx, {
      at: this.deps.now(),
      kind: "error",
      route: "cloud",
      rung: 3,
      plan,
      model: entry.model,
      thinking: entry.thinking,
      reasons,
    }).catch(() => undefined);
    ctx.ui.notify(
      `spore/auto: rung 3 ${plan} → ${entry.model} (${entry.thinking}) (${reasons[0]})`,
      "warning",
    );
    return {
      model: this.find(ctx, entry.model),
      thinkingLevel: entry.thinking,
      ...(request.reason === "direct"
        ? {}
        : {
            state: {
              route: "cloud",
              rung: 3,
              plan,
              model: entry.model,
              thinking: entry.thinking,
              failures: 0,
              decidedAt: this.deps.now(),
              reasons,
            },
          }),
    };
  }

  private find(ctx: ExtensionContext, ref: string) {
    const { provider, id } = splitModel(ref);
    const model = ctx.modelRegistry.find(provider, id);
    if (!model) throw new Error(`${ref} is not in the model catalog`);
    return model;
  }

  private async classify(
    settings: RouterSettings,
    brief: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<JevAnswers | { error: string }> {
    const { provider, id } = splitModel(settings.classifier);
    const classifier = ctx.modelRegistry.findOfType("classifier", provider, id);
    if (!classifier) return { error: `classifier ${settings.classifier} is not in the catalog` };
    try {
      const result = await ctx.modelRegistry.classify(
        classifier,
        { state: { prompt: brief.slice(0, MAX_PROMPT_CHARS) }, questions: QUESTIONS },
        signal ? { signal } : {},
      );
      return readAnswers(result);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { error: errorText(error) };
    }
  }

  private async planStates(settings: RouterSettings): Promise<Record<string, PlanState>> {
    const names = [...new Set(settings.ladders.map((ladder) => ladder.plan))].sort();
    const options = {
      maxAgeMs: settings.usageMaxAgeMinutes * 60_000,
      weekly: settings.pressure.weekly,
      fiveHour: settings.pressure.fiveHour,
    };
    const now = this.deps.now();
    const states: Record<string, PlanState> = {};
    for (const plan of names) {
      try {
        states[plan] = planState(plan, await readPlan(this.deps.home, plan), now, options);
      } catch (error) {
        states[plan] = {
          plan,
          room: "unknown",
          pressure: false,
          notes: [`${plan}: ${errorText(error)}`],
        };
      }
    }
    return states;
  }

  /**
   * Holds a slot on the target for this run, waiting while other sessions use it, then lets the extension that runs
   * the target start it and checks its health URL (ADR 0010). Strata itself stays with `strata-model.ts`.
   */
  private async holdLocal(
    target: LocalTarget,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.held.has(target.model)) return;
    const locks = this.deps.locks();
    const session = ctx.sessionManager.getSessionId();
    const { provider, id } = splitModel(target.model);
    // The wait file tells other sessions the queue is not empty (ADR 0141).
    let waitFile: string | undefined;
    try {
      for (;;) {
        const path = await locks.tryAcquire(target.model, target.concurrency, session);
        if (path) {
          this.held.set(target.model, path);
          break;
        }
        if (!waitFile) {
          waitFile = await locks.joinQueue(target.model, session);
          ctx.ui.setStatus(STATUS_KEY, `Waiting for ${id}`);
          ctx.ui.notify(`Waiting for ${id}: another session is using it`, "info");
        }
        await this.deps.sleep(LOCK_POLL_MS, signal);
      }
    } finally {
      if (waitFile) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        await locks.leaveQueue(waitFile);
      }
    }
    try {
      await Promise.all(this.deps.announceLocal({ provider, modelId: id }, ctx));
      if (target.healthUrl && !(await this.deps.healthy(target.healthUrl, signal))) {
        throw new Error(`${target.model} does not answer at ${target.healthUrl}`);
      }
    } catch (error) {
      await this.releaseTarget(target.model);
      throw error;
    }
  }

  private async releaseTarget(model: string): Promise<void> {
    const path = this.held.get(model);
    if (!path) return;
    this.held.delete(model);
    await this.deps.locks().release(path);
  }

  private async record(
    ctx: ExtensionContext,
    record: Omit<RoutingRecord, "sessionId" | "sessionFile" | "cwd" | "agentId" | "workspaceId">,
  ): Promise<void> {
    const { env } = this.deps;
    const sessionFile = ctx.sessionManager.getSessionFile();
    await appendRecord(this.deps.home, {
      ...record,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(sessionFile ? { sessionFile } : {}),
      cwd: ctx.cwd,
      ...(env.PI_SPORE_AGENT_ID ? { agentId: env.PI_SPORE_AGENT_ID } : {}),
      ...(env.PI_SPORE_WORKSPACE_ID ? { workspaceId: env.PI_SPORE_WORKSPACE_ID } : {}),
    });
  }
}
