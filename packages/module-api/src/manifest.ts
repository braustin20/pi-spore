export interface ModuleManifest {
  /** Unique, kebab-case. */
  readonly id: string;
  /** Ids of modules this one needs. They are set up first and must be enabled. */
  readonly requires: readonly string[];
  /** Core modules cannot be disabled. */
  readonly core: boolean;
}

/**
 * Names an operation or interface that one module exports to others.
 *
 * The type parameter is carried only for type checking; `owner` is the id of the module that may provide it.
 */
export interface InterfaceKey<T> {
  readonly owner: string;
  readonly name: string;
  readonly __type?: T;
}

export function defineInterface<T>(owner: string, name: string): InterfaceKey<T> {
  return { owner, name };
}

/** The part of a host that every module gets, on the server and in the web app. */
export interface ModuleInterfaces {
  provide<T>(key: InterfaceKey<T>, implementation: T): void;
  use<T>(key: InterfaceKey<T>): T;
}
