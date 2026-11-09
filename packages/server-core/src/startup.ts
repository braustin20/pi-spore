import {
  createInterfaceBroker,
  type EventHub,
  type Exec,
  type HomePaths,
  type Logger,
  resolveModules,
  type ServerModule,
  type Store,
} from "@pi-spore/module-api";
import { Hono } from "hono";
import type { AgentTokenStore } from "./agent-tokens.js";
import type { JobService } from "./jobs.js";
import { createSettings } from "./settings.js";
import type { SocketRouter } from "./sockets.js";

export interface HostServices {
  events: EventHub;
  log: Logger;
  store: Store;
  home: HomePaths;
  exec: Exec;
  now: () => number;
  newId: () => string;
  /** The server's base URL, for agent processes. */
  url: string;
  agentTokens: AgentTokenStore;
  /** WebSocket routes; each module adds its own through `host.sockets`. */
  sockets: SocketRouter;
  jobs: JobService;
}

export interface SetUpModule {
  id: string;
  routes: Hono;
}

/**
 * Validates the registry and sets modules up in dependency order. Any registry error stops startup: a server with a
 * half-valid module set would fail later in harder-to-read ways.
 */
export async function setupModules(
  registry: readonly ServerModule[],
  disabled: readonly string[],
  services: HostServices,
): Promise<SetUpModule[]> {
  const ordered = resolveModules(registry, disabled);
  const broker = createInterfaceBroker();
  const result: SetUpModule[] = [];
  const settings = createSettings(services.home.root);
  const startedListeners: (() => Promise<void> | void)[] = [];
  // Core owns core_idempotency, so modules prune it through the host and never query it.
  const pruneResponses = (before: number): number =>
    services.store.run("DELETE FROM core_idempotency WHERE created_at < ?", before).changes;
  for (const module of ordered) {
    const routes = new Hono();
    await module.setup({
      ...broker.forModule(module),
      ...services,
      routes,
      sockets: services.sockets.forModule(module.id),
      jobs: services.jobs.forModule(module.id),
      settings,
      onStarted: (listener) => {
        startedListeners.push(listener);
      },
      pruneResponses,
    });
    result.push({ id: module.id, routes });
  }
  // Every key is declared by now, so a bad settings file stops startup here.
  await settings.finishDeclaring();
  // Every kind is defined by now, so jobs of a disabled module are the only ones left untouched.
  services.jobs.resume();
  for (const listener of startedListeners) {
    try {
      await listener();
    } catch (error) {
      services.log.error("A start listener failed", { error: String(error) });
    }
  }
  return result;
}
