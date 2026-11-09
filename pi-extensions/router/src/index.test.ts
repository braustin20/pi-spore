import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sporeRouter, { LOCAL_ROUTE_EVENT } from "./index.js";
import { readRecords } from "./records.js";
import type { RouterState } from "./router.js";
import { fakeContext, STRATA, userRequest } from "./test-fakes.js";
import { readPlan } from "./usage.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-spore-ext-"));
  for (const dir of ["home", "run", "agent", "project"]) mkdirSync(join(root, dir));
  vi.stubEnv("PI_SPORE_HOME", join(root, "home"));
  vi.stubEnv("XDG_RUNTIME_DIR", join(root, "run"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  // No health URL, so the test never touches the network.
  writeFileSync(
    join(root, "home", "settings.json"),
    JSON.stringify({
      router: {
        localTargets: [
          { model: STRATA, thinking: "high", contextWindow: 131072, budget: 0.5, concurrency: 1 },
        ],
      },
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** The parts of the extension API the router uses, recording what it registers. */
function fakePi() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  let virtual: { provider: string; id: string; route: Handler } | undefined;
  const api = {
    registerVirtualModel: (definition: typeof virtual) => {
      virtual = definition;
    },
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    events: {
      emit: (channel: string, data: unknown) => {
        for (const listener of listeners.get(channel) ?? []) listener(data);
      },
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        return () => {};
      },
    },
  };
  // SAFETY: the router extension only calls registerVirtualModel, on, and events.
  sporeRouter(api as unknown as ExtensionAPI);
  return { api, handlers, virtual: () => virtual };
}

describe("router extension", () => {
  it("registers spore/auto and the usage tap", async () => {
    const pi = fakePi();
    expect(pi.virtual()).toMatchObject({ provider: "spore", id: "auto" });
    expect([...pi.handlers.keys()].sort()).toEqual([
      "after_provider_response",
      "agent_settled",
      "provider_stream_event",
      "session_shutdown",
    ]);

    await pi.handlers.get("after_provider_response")?.({
      status: 200,
      headers: { "anthropic-ratelimit-unified-5h-utilization": "0.25" },
    });
    expect((await readPlan(join(root, "home"), "claude"))?.windows["5h"]?.utilization).toBe(0.25);
  });

  it("asks the extension that runs the local target to start it, and waits for it", async () => {
    const pi = fakePi();
    let ready: () => void = () => {};
    const seen: unknown[] = [];
    pi.api.events.on(LOCAL_ROUTE_EVENT, (data) => {
      const event = data as {
        provider: string;
        modelId: string;
        ctx: ExtensionContext;
        wait(p: Promise<unknown>): void;
      };
      seen.push({
        provider: event.provider,
        modelId: event.modelId,
        hasCtx: event.ctx !== undefined,
      });
      event.wait(new Promise<void>((resolve) => (ready = resolve)));
    });
    const { ctx } = fakeContext(join(root, "project"));
    let settled = false;
    const routing = Promise.resolve(
      pi.virtual()?.route(userRequest("Add a clamp helper to math.ts and a test."), ctx),
    ).then((route) => {
      settled = true;
      return route as { state: RouterState };
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({
      provider: "strata",
      modelId: "qwen3.8-flash-next-unsloth-ud-iq2_xs",
      hasCtx: true,
    });
    expect(settled).toBe(false);
    ready();
    expect((await routing).state).toMatchObject({
      route: "local",
      rung: 1,
      model: STRATA,
      thinking: "high",
    });

    const { records } = await readRecords(join(root, "home"), 5);
    expect(records[0]).toMatchObject({ route: "local", model: STRATA });

    // The run settles: the slot is free for another session.
    await pi.handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false });
  });
});
