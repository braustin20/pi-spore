/**
 * pi-spore router: registers the virtual model `spore/auto` (ADR 0009) and taps plan usage from provider responses
 * (ADR 0022). Works in pi-spore agents and in plain `pi`:
 *
 *   pi -e <repo>/pi-extensions/router --model spore/auto
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { LocalLocks, lockDir } from "./lock.js";
import { Router, type RouterState } from "./router.js";
import { sporeHome } from "./settings.js";

/** Channel other extensions listen on to start a local provider the router is about to use. */
export const LOCAL_ROUTE_EVENT = "pi-spore:local-route";

const HEALTH_TIMEOUT_MS = 3_000;

/** `subagents.agentOverrides.worker.model` from Pi's settings, the default cloud model (ADR 0013). */
async function workerModel(): Promise<string | undefined> {
  const path = join(getAgentDir(), "settings.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const model = (
    settings as { subagents?: { agentOverrides?: { worker?: { model?: unknown } } } } | null
  )?.subagents?.agentOverrides?.worker?.model;
  return typeof model === "string" && model.includes("/") ? model : undefined;
}

export default function sporeRouter(pi: ExtensionAPI) {
  let locks: LocalLocks | undefined;
  const router = new Router({
    home: sporeHome(),
    env: process.env,
    now: Date.now,
    sleep: async (ms, signal) => {
      await delay(ms, undefined, signal ? { signal } : {});
    },
    locks: () => {
      locks ??= new LocalLocks(lockDir());
      return locks;
    },
    healthy: async (url, signal) => {
      const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        return response.ok;
      } catch (error) {
        if (signal?.aborted) throw error;
        return false;
      }
    },
    announceLocal: (target, ctx) => {
      const waits: Promise<unknown>[] = [];
      pi.events.emit(LOCAL_ROUTE_EVENT, {
        ...target,
        ctx,
        wait: (ready: Promise<unknown>) => waits.push(ready),
      });
      return waits;
    },
    workerModel,
    isOverflow: isContextOverflow,
  });

  pi.registerVirtualModel<RouterState>({
    provider: "spore",
    id: "auto",
    name: "Auto (pi-spore router)",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    route: (request, ctx) => router.route(request, ctx),
  });

  pi.on("after_provider_response", (event) => router.onResponse(event.headers));
  pi.on("provider_stream_event", (event) => router.onStreamEvent(event.data));
  pi.on("agent_settled", () => router.releaseAll());
  pi.on("session_shutdown", () => router.releaseAll());
}
