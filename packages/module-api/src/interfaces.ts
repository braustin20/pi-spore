import type { InterfaceKey, ModuleInterfaces, ModuleManifest } from "./manifest.js";
import { ModuleRegistryError } from "./registry.js";

/**
 * Holds the interfaces modules export, and gives each module a view that enforces the contract: a module provides
 * only its own keys and uses only keys of modules it requires.
 */
export function createInterfaceBroker(): { forModule(module: ModuleManifest): ModuleInterfaces } {
  const provided = new Map<string, unknown>();
  const keyId = (key: InterfaceKey<unknown>) => `${key.owner}/${key.name}`;

  return {
    forModule(module) {
      return {
        provide(key, implementation) {
          if (key.owner !== module.id) {
            throw new ModuleRegistryError(
              `Module "${module.id}" cannot provide "${keyId(key)}", which belongs to "${key.owner}"`,
            );
          }
          if (provided.has(keyId(key))) {
            throw new ModuleRegistryError(`Interface "${keyId(key)}" is provided more than once`);
          }
          provided.set(keyId(key), implementation);
        },
        use<T>(key: InterfaceKey<T>): T {
          if (key.owner !== module.id && !module.requires.includes(key.owner)) {
            throw new ModuleRegistryError(
              `Module "${module.id}" uses "${keyId(key)}" but does not require "${key.owner}"`,
            );
          }
          if (!provided.has(keyId(key))) {
            throw new ModuleRegistryError(
              `Interface "${keyId(key)}" was not provided by "${key.owner}" during its setup`,
            );
          }
          return provided.get(keyId(key)) as T;
        },
      };
    },
  };
}
