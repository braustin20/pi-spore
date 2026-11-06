import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventHub, Exec, Logger, ServerModule } from "@pi-spore/module-api";
import { CORE_MIGRATIONS, createApp } from "./app.js";
import { exec as realExec } from "./exec.js";
import { ensureHome, resolveHome, type ServerPaths } from "./home.js";
import { type HostServices, setupModules } from "./startup.js";
import { SqliteStore } from "./store.js";

export const TEST_TOKEN = "t".repeat(64);

/** An in-process EventHub for tests: records every published event and runs subscription snapshots on demand. */
export class MemoryHub implements EventHub {
  readonly published: { topic: string; event: unknown }[] = [];
  private readonly handlers: {
    prefix: string;
    handler: (topic: string) => unknown[] | Promise<unknown[]>;
  }[] = [];

  publish(topic: string, event: unknown): void {
    this.published.push({ topic, event });
  }

  onSubscribe(prefix: string, handler: (topic: string) => unknown[] | Promise<unknown[]>): void {
    this.handlers.push({ prefix, handler });
  }

  /** The snapshot a new subscriber to `topic` would get. */
  async snapshot(topic: string): Promise<unknown[]> {
    const match = this.handlers
      .filter((candidate) => topic.startsWith(candidate.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (!match) throw new Error(`No handler for topic ${topic}`);
    return match.handler(topic);
  }

  /** Events published to `topic` so far. */
  eventsOf(topic: string): unknown[] {
    return this.published.filter((entry) => entry.topic === topic).map((entry) => entry.event);
  }
}

export const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export interface TestServer {
  paths: ServerPaths;
  store: SqliteStore;
  services: HostServices;
  events: MemoryHub;
  /** Sends a request as the CLI would: loopback host, the token, JSON. */
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  close(): void;
}

/**
 * A server with real modules on a temp home and an in-memory store. Clock and ids are deterministic. `exec` is the
 * real one unless a fake is given, so tests can run real git in temp folders.
 */
export async function createTestServer(
  modules: readonly ServerModule[],
  options: { exec?: Exec; startAt?: number } = {},
): Promise<TestServer> {
  const root = mkdtempSync(join(tmpdir(), "pi-spore-test-"));
  const paths = resolveHome({ PI_SPORE_HOME: root });
  ensureHome(paths);
  const store = new SqliteStore(":memory:");
  store.migrate("core", CORE_MIGRATIONS);
  let clock = options.startAt ?? 1_700_000_000_000;
  let counter = 0;
  const events = new MemoryHub();
  const services: HostServices = {
    events,
    log: silentLog,
    store,
    home: paths,
    exec: options.exec ?? realExec,
    now: () => clock++,
    newId: () => `01TEST${String(++counter).padStart(20, "0")}`,
  };
  const setUp = await setupModules(modules, [], services);
  const app = createApp({
    version: "0.0.0-test",
    modules: setUp,
    startedAt: 0,
    now: services.now,
    token: TEST_TOKEN,
    store,
    log: silentLog,
  });
  return {
    paths,
    store,
    services,
    events,
    request: async (method, path, body, headers = {}) =>
      await app.request(path, {
        method,
        headers: {
          host: "127.0.0.1:7420",
          "x-pi-spore-token": TEST_TOKEN,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
