import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { cloudChoice, type Decision, decide, escalation, type Route } from "./decide.js";
import { contentText, type Estimate, estimateTokens } from "./estimate.js";
import { type JevAnswers, MAX_PROMPT_CHARS, QUESTIONS, readAnswers } from "./jev.js";
import type { LocalLocks } from "./lock.js";
import { appendRecord, type RoutingRecord } from "./records.js";
import { type LocalTarget, loadSettings, type RouterSettings, splitModel } from "./settings.js";
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
  /** `provider/id` the session is pinned to. */
  model: string;
  /** Failed local requests in a row. */
  failures: number;
  decidedAt: number;
  reasons: string[];
}

export type RouterRequest = ModelRouteRequest<RouterState>;

/** Thrown when no plan has room: Pi ends the request with this message (ADR 0024: the task waits for a reset). */
export class NoRoomError extends Error {
  override name = "NoRoomError";
}

export interface RouterDeps {
  /** pi-spore's home folder (`~/.pi-spore`). */
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  now(): number;
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
  /** The cloud model when `router.cloud` is unset: the pi-subagents `worker` model. */
  workerModel(): Promise<string | undefined>;
  isOverflow(message: AssistantMessage, contextWindow?: number): boolean;
}

/** How long to wait between looks at a busy local target's lock. */
const AUTO_MODEL = "spore/auto";
const LOCK_POLL_MS = 1_000;
const STATUS_KEY = "pi-spore-router";

function lastUserText(messages: RouterRequest["messages"]): string {
  const message = messages.filter((candidate) => candidate.role === "user").at(-1);
  return message ? contentText(message.content) : "";
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The `spore/auto` router (ADR 0009, 0010, 0024) and the usage tap (ADR 0022). One instance per Pi process. It holds
 * the local slots this process took, released when the agent run settles or the session shuts down.
 */
export class Router {
  private readonly held = new Map<string, string>();
  /** The cloud model of the last settings read, for routing after the router's own errors. */
  private lastCloud: string | undefined;

  constructor(private readonly deps: RouterDeps) {}

  async route(request: RouterRequest, ctx: ExtensionContext): Promise<ModelRoute<RouterState>> {
    try {
      return await this.routeOrThrow(request, ctx);
    } catch (error) {
      if (error instanceof NoRoomError || request.signal?.aborted) throw error;
      return this.fallBack(request, ctx, error);
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
  ): Promise<ModelRoute<RouterState>> {
    const settings = await loadSettings(this.deps.home);
    const cloud = await this.cloudModel(settings);
    const state = request.state;

    if (request.reason === "direct") {
      // Compaction summaries and other side requests: stay on the model that answered last.
      const model = request.previous?.model ?? this.find(ctx, cloud);
      return { model, thinkingLevel: request.thinkingLevel };
    }
    if (!state) return this.decideNew(request, ctx, settings, cloud);
    if (state.route !== "local") {
      return { model: this.find(ctx, state.model), thinkingLevel: request.thinkingLevel };
    }

    const target = settings.localTargets.find((candidate) => candidate.model === state.model);
    if (!target) {
      return this.escalate(
        request,
        ctx,
        settings,
        cloud,
        state,
        `${state.model} is no longer a local target`,
      );
    }
    let next: RouterState = state;
    if (request.reason === "retry" && request.failed) {
      const failed = request.failed.message;
      const verdict = escalation(state.failures, {
        overflow: this.deps.isOverflow(failed, target.contextWindow),
        ...(failed.errorMessage ? { errorMessage: failed.errorMessage } : {}),
      });
      if (verdict.escalate) {
        return this.escalate(
          request,
          ctx,
          settings,
          cloud,
          state,
          verdict.reason ?? "failed on local",
        );
      }
      if (verdict.failures !== state.failures) next = { ...state, failures: verdict.failures };
    } else if (state.failures > 0) {
      next = { ...state, failures: 0 };
    }
    try {
      await this.holdLocal(target, ctx, request.signal);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      return this.escalate(
        request,
        ctx,
        settings,
        cloud,
        state,
        `local target not ready: ${errorText(error)}`,
      );
    }
    return {
      model: this.find(ctx, target.model),
      thinkingLevel: request.thinkingLevel,
      ...(next === state ? {} : { state: next }),
    };
  }

  private async decideNew(
    request: RouterRequest,
    ctx: ExtensionContext,
    settings: RouterSettings,
    cloud: string,
  ): Promise<ModelRoute<RouterState>> {
    const plans = await this.planStates(settings);
    const brief = lastUserText(request.messages);
    const target = settings.localTargets.find((candidate) => {
      const { provider, id } = splitModel(candidate.model);
      return ctx.modelRegistry.find(provider, id) !== undefined;
    });

    let estimate: Estimate | undefined;
    let budget: number | undefined;
    let jev: JevAnswers | { error: string } | undefined;
    if (target) {
      budget = Math.floor(target.contextWindow * target.budget);
      estimate = await estimateTokens(ctx.getSystemPrompt(), request.messages, brief, ctx.cwd);
      if (estimate.total <= budget) jev = await this.classify(settings, brief, ctx, request.signal);
    }

    let decision = decide({
      settings,
      cloud,
      local:
        target && budget !== undefined
          ? { model: target.model, budget }
          : { missing: "no local target in the catalog" },
      ...(estimate ? { estimate: estimate.total } : {}),
      ...(jev ? { jev } : {}),
      plans,
    });
    if (decision.route === "local" && target) {
      try {
        await this.holdLocal(target, ctx, request.signal);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const choice = cloudChoice(settings, cloud, plans);
        decision = {
          ...decision,
          ...choice,
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
      route: decision.route,
      ...(decision.model ? { model: decision.model } : {}),
      reasons: decision.reasons,
      ...(estimate ? { estimate: estimate.total } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(jev ? { jev } : {}),
      threshold: decision.threshold,
      pressure: decision.pressure,
      usage: Object.values(plans).flatMap((plan) => plan.notes),
      ...(decision.resetsAt !== undefined ? { resetsAt: decision.resetsAt } : {}),
    });
    return this.finish(request, ctx, decision);
  }

  /** Moves a local session to the cloud model (or a spill model) and records why. */
  private async escalate(
    request: RouterRequest,
    ctx: ExtensionContext,
    settings: RouterSettings,
    cloud: string,
    state: RouterState,
    reason: string,
  ): Promise<ModelRoute<RouterState>> {
    await this.releaseTarget(state.model);
    const plans = await this.planStates(settings);
    const choice = cloudChoice(settings, cloud, plans);
    const decision: Decision = {
      ...choice,
      reasons: [reason, ...choice.reasons],
      pressure: false,
      threshold: settings.threshold,
    };
    await this.record(ctx, {
      at: this.deps.now(),
      kind: "escalation",
      route: decision.route,
      ...(decision.model ? { model: decision.model } : {}),
      reasons: decision.reasons,
      usage: Object.values(plans).flatMap((plan) => plan.notes),
      ...(decision.resetsAt !== undefined ? { resetsAt: decision.resetsAt } : {}),
    });
    return this.finish(request, ctx, decision);
  }

  private finish(
    request: RouterRequest,
    ctx: ExtensionContext,
    decision: Decision,
  ): ModelRoute<RouterState> {
    if (decision.route === "wait" || !decision.model) {
      const when = decision.resetsAt ? ` until ${new Date(decision.resetsAt).toISOString()}` : "";
      throw new NoRoomError(`No plan has room${when}: ${decision.reasons.join("; ")}`);
    }
    ctx.ui.notify(
      `spore/auto: ${decision.route} → ${decision.model} (${decision.reasons.join("; ")})`,
      "info",
    );
    return {
      model: this.find(ctx, decision.model),
      thinkingLevel: request.thinkingLevel,
      state: {
        route: decision.route,
        model: decision.model,
        failures: 0,
        decidedAt: this.deps.now(),
        reasons: decision.reasons,
      },
    };
  }

  /** The router's own failure: send the request to the cloud model, pin the session there, and record why. */
  private async fallBack(
    request: RouterRequest,
    ctx: ExtensionContext,
    error: unknown,
  ): Promise<ModelRoute<RouterState>> {
    const candidate = this.lastCloud ?? (await this.deps.workerModel().catch(() => undefined));
    // Routing to itself would loop, so a misconfigured cloud model ends in the error that names the setting.
    const cloud = candidate === AUTO_MODEL ? undefined : candidate;
    if (!cloud)
      throw new Error(
        `spore/auto failed and has no cloud model to fall back to: ${errorText(error)}`,
      );
    const reasons = [`router error: ${errorText(error)}`];
    await this.record(ctx, {
      at: this.deps.now(),
      kind: "error",
      route: "cloud",
      model: cloud,
      reasons,
    }).catch(() => undefined);
    ctx.ui.notify(`spore/auto: cloud → ${cloud} (${reasons[0]})`, "warning");
    return {
      model: this.find(ctx, cloud),
      thinkingLevel: request.thinkingLevel,
      ...(request.reason === "direct"
        ? {}
        : {
            state: {
              route: "cloud",
              model: cloud,
              failures: 0,
              decidedAt: this.deps.now(),
              reasons,
            },
          }),
    };
  }

  private async cloudModel(settings: RouterSettings): Promise<string> {
    const cloud = settings.cloud ?? (await this.deps.workerModel());
    if (!cloud) {
      throw new Error(
        'No cloud model: set "router.cloud" in pi-spore settings.json or subagents.agentOverrides.worker.model in Pi settings',
      );
    }
    if (cloud === AUTO_MODEL) {
      throw new Error(
        `${AUTO_MODEL} cannot be its own cloud model: set "router.cloud" in ${join(this.deps.home, "settings.json")} to a real model (ADR 0120)`,
      );
    }
    splitModel(cloud);
    this.lastCloud = cloud;
    return cloud;
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
    const names = [...new Set(Object.values(settings.plans))].sort();
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
    let waiting = false;
    try {
      for (;;) {
        const path = await locks.tryAcquire(target.model, target.concurrency, session);
        if (path) {
          this.held.set(target.model, path);
          break;
        }
        if (!waiting) {
          waiting = true;
          ctx.ui.setStatus(STATUS_KEY, `Waiting for ${id}`);
          ctx.ui.notify(`Waiting for ${id}: another session is using it`, "info");
        }
        await this.deps.sleep(LOCK_POLL_MS, signal);
      }
    } finally {
      if (waiting) ctx.ui.setStatus(STATUS_KEY, undefined);
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
