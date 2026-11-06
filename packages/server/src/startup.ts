import {
  createInterfaceBroker,
  type Logger,
  resolveModules,
  type ServerModule,
} from "@pi-spore/module-api";

/**
 * Validates the registry and sets modules up in dependency order. Any registry error stops startup: a server with a
 * half-valid module set would fail later in harder-to-read ways.
 */
export async function setupModules(
  registry: readonly ServerModule[],
  disabled: readonly string[],
  log: Logger,
): Promise<ServerModule[]> {
  const ordered = resolveModules(registry, disabled);
  const broker = createInterfaceBroker();
  for (const module of ordered) {
    await module.setup({ ...broker.forModule(module), log });
  }
  return ordered;
}
