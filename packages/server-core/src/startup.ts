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
  for (const module of ordered) {
    const routes = new Hono();
    await module.setup({ ...broker.forModule(module), ...services, routes });
    result.push({ id: module.id, routes });
  }
  return result;
}
