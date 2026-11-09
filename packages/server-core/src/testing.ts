import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import type { EventHub, Exec, JobTimer, Logger, ServerModule } from "@pi-spore/module-api";
import type { Hono } from "hono";
import { AgentTokenStore } from "./agent-tokens.js";
import { CORE_MIGRATIONS, createApp } from "./app.js";
import { exec as realExec } from "./exec.js";
import { ensureHome, resolveHome, type ServerPaths } from "./home.js";
import { createJobService, realTimer } from "./jobs.js";
import { attachUpgrades, SocketRouter } from "./sockets.js";
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
  agentTokens: AgentTokenStore;
  /** The base URL agents get. It answers only when the server was created with `listen`. */
  url: string;
  /** Sends a request as the CLI would: loopback host, the token, JSON. `peer` is the socket's remote address. */
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    peer?: string,
  ): Promise<Response>;
  close(): void;
}

/** Listens on a free loopback port and hands requests to the app once it exists. */
async function listen(app: () => Hono | undefined): Promise<Server> {
  const server = createServer((request, response) => {
    const current = app();
    if (!current) {
      response.writeHead(503).end();
      return;
    }
    void getRequestListener(current.fetch)(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/**
 * A server with real modules on a temp home and an in-memory store. Clock and ids are deterministic. `exec` is the
 * real one unless a fake is given, so tests can run real git in temp folders. With `listen`, it also answers HTTP on
 * a loopback port, so child processes such as a fake agent can call the bridge routes, and tests can open module
 * sockets. With `home`, it keeps its
 * store in a file there and leaves the folder on close, so a second server on the same home acts as a restart.
 */
export async function createTestServer(
  modules: readonly ServerModule[],
  options: {
    exec?: Exec;
    startAt?: number;
    listen?: boolean;
    home?: string;
    /** Where the id counter starts, so a restarted server does not hand out the first server's ids again. */
    firstId?: number;
    /** Schedules delayed job steps. Real unless a fake is given, so tests control delays. */
    timer?: JobTimer;
  } = {},
): Promise<TestServer> {
  const root = options.home ?? mkdtempSync(join(tmpdir(), "pi-spore-test-"));
  const paths = resolveHome({ PI_SPORE_HOME: root });
  ensureHome(paths);
  const store = new SqliteStore(options.home ? paths.database : ":memory:");
  store.migrate("core", CORE_MIGRATIONS);
  let clock = options.startAt ?? 1_700_000_000_000;
  let counter = options.firstId ?? 0;
  const events = new MemoryHub();
  let app: Hono | undefined;
  const http = options.listen ? await listen(() => app) : undefined;
  const port = http ? (http.address() as AddressInfo).port : 7420;
  const url = `http://127.0.0.1:${port}`;
  const agentTokens = new AgentTokenStore();
  const sockets = new SocketRouter(silentLog);
  const now = () => clock++;
  const newId = () => `01TEST${String(++counter).padStart(20, "0")}`;
  const jobs = createJobService({
    store,
    log: silentLog,
    now,
    newId,
    timer: options.timer ?? realTimer,
  });
  const services: HostServices = {
    events,
    log: silentLog,
    store,
    home: paths,
    exec: options.exec ?? realExec,
    now,
    newId,
    url,
    agentTokens,
    sockets,
    jobs,
  };
  const setUp = await setupModules(modules, [], services);
  if (http) {
    attachUpgrades(http, TEST_TOKEN, setUp.remoteAccess, (pathname) => sockets.route(pathname));
  }
  const created = createApp({
    version: "0.0.0-test",
    modules: setUp.modules,
    remoteAccess: setUp.remoteAccess,
    startedAt: 0,
    now: services.now,
    token: TEST_TOKEN,
    agentTokens,
    store,
    jobs,
    log: silentLog,
  });
  app = created;
  return {
    paths,
    store,
    services,
    events,
    agentTokens,
    url,
    request: async (method, path, body, headers = {}, peer = "127.0.0.1") =>
      await created.request(
        path,
        {
          method,
          headers: {
            host: "127.0.0.1:7420",
            "x-pi-spore-token": TEST_TOKEN,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        { incoming: { socket: { remoteAddress: peer } } },
      ),
    close: () => {
      jobs.stop();
      sockets.close();
      http?.closeAllConnections();
      http?.close();
      store.close();
      if (!options.home) rmSync(root, { recursive: true, force: true });
    },
  };
}
