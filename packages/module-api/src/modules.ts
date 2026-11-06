import type { ModuleInterfaces, ModuleManifest } from "./manifest.js";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * What a server module gets during setup. Settings, store, jobs, events, and routes are added as the modules that
 * need them land (docs/architecture.md section 4).
 */
export interface ServerHost extends ModuleInterfaces {
  readonly log: Logger;
}

export interface ServerModule extends ModuleManifest {
  setup(host: ServerHost): void | Promise<void>;
}

/** What a web module gets during setup. Routes, panels, and Home cards are added with the first web module. */
export interface WebHost extends ModuleInterfaces {}

export interface WebModule extends ModuleManifest {
  setup(host: WebHost): void;
}
