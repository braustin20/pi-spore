import type { Hono } from "hono";
import type { ComponentType } from "react";
import type { AgentTokens } from "./bridge.js";
import type { ModuleInterfaces, ModuleManifest } from "./manifest.js";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * The shared SQLite store. Each module owns tables named `<module id>_<name>` (with `-` in the id replaced by `_`)
 * and creates them through its own migrations. Rows are typed by the caller: the database is inside the boundary.
 */
export interface Store {
  /** Applies each migration of this module once, in order. Migration n is `migrations[n - 1]`. */
  migrate(moduleId: string, migrations: readonly string[]): void;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** Runs `fn` in one transaction. A throw rolls everything back. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}

/** Runs a program with an argv array, never through a shell. Resolves with any exit code; rejects only on spawn
 * failure or timeout. */
export type Exec = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export interface HomePaths {
  root: string;
  worktrees: string;
  artifacts: string;
  logs: string;
  sessions: string;
}

/** Live events for browsers, by topic such as `agent:<id>`. */
export interface EventHub {
  /** Sends an event to every browser subscribed to `topic`. */
  publish(topic: string, event: unknown): void;
  /**
   * Handles subscriptions to topics that start with `prefix`. The handler returns the events a new subscriber gets
   * first (a snapshot); events published while it runs are delivered after them, in order. Throw an ApiError to
   * refuse the subscription.
   */
  onSubscribe(prefix: string, handler: (topic: string) => unknown[] | Promise<unknown[]>): void;
}

/** A WebSocket a module accepted. Frames are text. The module validates every message it gets. */
export interface ModuleSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

/**
 * Checks the params of an upgrade and returns what to do with the accepted socket. Throw an ApiError to refuse the
 * upgrade with its status, before any socket exists.
 */
export type SocketOpener = (
  params: Readonly<Record<string, string>>,
) => (socket: ModuleSocket) => void;

export interface SocketRoutes {
  /**
   * Accepts WebSocket upgrades at `/api/<module id><path>`, such as `/:id/socket`, where `:name` segments become
   * params. The server checks the user's token (`?token=`), the loopback Host, and the Origin first.
   */
  add(path: string, open: SocketOpener): void;
}

/** What a server module gets during setup. Settings and jobs are added with the modules that need them. */
export interface ServerHost extends ModuleInterfaces {
  readonly events: EventHub;
  readonly log: Logger;
  readonly store: Store;
  /** Routes of this module, mounted at `/api/<module id>/`. */
  readonly routes: Hono;
  /** WebSocket routes of this module, under `/api/<module id>/`. */
  readonly sockets: SocketRoutes;
  readonly home: HomePaths;
  readonly exec: Exec;
  readonly now: () => number;
  /** A new unique id: 26 characters, sortable by creation time. */
  readonly newId: () => string;
  /** The server's own base URL, such as `http://127.0.0.1:7420`, for agent processes. */
  readonly url: string;
  readonly agentTokens: AgentTokens;
  /** Runs after every module's setup, before the server listens. A throw is logged and does not stop startup. */
  onStarted(listener: () => Promise<void> | void): void;
  /** Deletes stored API responses (idempotency records) created before `before`, a time in ms. Returns the count. */
  pruneResponses(before: number): number;
}

export interface ServerModule extends ModuleManifest {
  setup(host: ServerHost): void | Promise<void>;
}

export interface ApiClient {
  /** GET `/api/<path>` and return the parsed JSON body. Throws `ApiRequestError` on a non-2xx answer. */
  get(path: string): Promise<unknown>;
  /**
   * GET `/api/<path>` and return the body as a Blob, such as image bytes for a blob URL. The token goes in a header,
   * never in the URL. Throws `ApiRequestError` on a non-2xx answer.
   */
  getBlob(path: string): Promise<Blob>;
  /** Sends a mutating request with a fresh idempotency key. */
  send(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown>;
  /**
   * Receives the events of a topic: the snapshot first, then live events. Survives reconnects by subscribing again,
   * which sends a fresh snapshot. Returns a function that unsubscribes.
   */
  subscribe(topic: string, onEvent: (event: unknown) => void): () => void;
  /** The `ws:` URL of a module socket at `/api/<path>`, with the token. */
  socketUrl(path: string): string;
}

/** A page's entry in the shell's left rail. */
export interface RailItem {
  /** Lower comes first. Home is 0. */
  order: number;
  /** An icon component such as one from `lucide-react`. The rail sizes it through `className`. */
  icon: ComponentType<{ className?: string }>;
  /**
   * A React hook that returns a count to show on the icon, such as Home's open items. 0 shows nothing. The rail calls
   * it on every render, always, so it may use other hooks.
   */
  useBadge?: () => number;
}

export interface WebPage {
  /** Hash route such as `/projects/:id`. */
  path: string;
  title: string;
  /**
   * Shown as an icon in the left rail. The icon is lit on this path and every path below it. Pages without it are
   * reached by links only.
   */
  rail?: RailItem;
  /** Fills the area right of the rail. Full pages wrap their content in `Page` from `@pi-spore/ui`. */
  component: ComponentType<{ params: Readonly<Record<string, string>> }>;
}

/** What a web module gets during setup. */
export interface WebHost extends ModuleInterfaces {
  readonly api: ApiClient;
  addPage(page: WebPage): void;
}

export interface WebModule extends ModuleManifest {
  setup(host: WebHost): void;
}
