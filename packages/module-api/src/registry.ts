import type { ModuleManifest } from "./manifest.js";

export class ModuleRegistryError extends Error {
  override name = "ModuleRegistryError";
}

/**
 * Validates a registry list and returns the enabled modules in setup order.
 *
 * Dependencies come before their dependents. Among modules with no order between them, registry order is kept,
 * so startup is deterministic.
 */
export function resolveModules<M extends ModuleManifest>(
  modules: readonly M[],
  disabled: readonly string[] = [],
): M[] {
  const byId = new Map<string, M>();
  for (const module of modules) {
    if (byId.has(module.id)) {
      throw new ModuleRegistryError(`Module id "${module.id}" is registered more than once`);
    }
    byId.set(module.id, module);
  }

  const disabledIds = new Set(disabled);
  for (const id of disabledIds) {
    const module = byId.get(id);
    // A typo in the disabled list would otherwise leave a module running that the user meant to turn off.
    if (!module) throw new ModuleRegistryError(`Disabled module "${id}" is not registered`);
    if (module.core) throw new ModuleRegistryError(`Module "${id}" is core and cannot be disabled`);
  }

  const enabled = modules.filter((module) => !disabledIds.has(module.id));
  for (const module of enabled) {
    for (const required of module.requires) {
      if (!byId.has(required)) {
        throw new ModuleRegistryError(
          `Module "${module.id}" requires "${required}", which is not registered`,
        );
      }
      if (disabledIds.has(required)) {
        throw new ModuleRegistryError(
          `Module "${module.id}" requires "${required}", which is disabled`,
        );
      }
    }
  }

  const ordered: M[] = [];
  const done = new Set<string>();
  const visiting: string[] = [];

  const visit = (module: M): void => {
    if (done.has(module.id)) return;
    const start = visiting.indexOf(module.id);
    if (start !== -1) {
      const cycle = [...visiting.slice(start), module.id].join(" -> ");
      throw new ModuleRegistryError(`Module dependency cycle: ${cycle}`);
    }
    visiting.push(module.id);
    for (const required of module.requires) {
      // Presence was checked above.
      visit(byId.get(required) as M);
    }
    visiting.pop();
    done.add(module.id);
    ordered.push(module);
  };

  for (const module of enabled) visit(module);
  return ordered;
}
