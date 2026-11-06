import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, Logger, ServerModule } from "@pi-spore/module-api";
import { CORE_MIGRATIONS, createApp } from "./app.js";
import { exec as realExec } from "./exec.js";
import { ensureHome, resolveHome, type ServerPaths } from "./home.js";
import { type HostServices, setupModules } from "./startup.js";
import { SqliteStore } from "./store.js";

export const TEST_TOKEN = "t".repeat(64);

export const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export interface TestServer {
  paths: ServerPaths;
  store: SqliteStore;
  services: HostServices;
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
  const services: HostServices = {
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
