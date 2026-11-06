#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { Logger } from "@pi-spore/module-api";
import {
  acquireLock,
  CORE_MIGRATIONS,
  createApp,
  ensureHome,
  ensureToken,
  exec,
  newId,
  resolveHome,
  SqliteStore,
  setupModules,
} from "@pi-spore/server-core";
import { DEFAULT_PORT } from "@pi-spore/shared";
import { serverModules } from "./modules.js";

const log: Logger = {
  info: (message, fields) => console.log(message, fields ?? ""),
  warn: (message, fields) => console.warn(message, fields ?? ""),
  error: (message, fields) => console.error(message, fields ?? ""),
};

function readVersion(): string {
  const path = new URL("../package.json", import.meta.url);
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the server version from ${path.pathname}`, { cause: error });
  }
  if (
    typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
  ) {
    return pkg.version;
  }
  throw new Error("packages/server/package.json has no version");
}

function readPort(): number {
  const raw = process.env.PI_SPORE_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PI_SPORE_PORT must be a port number, got "${raw}"`);
  }
  return port;
}

const startedAt = Date.now();
const port = readPort();
const paths = resolveHome(process.env);
ensureHome(paths);
const releaseLock = acquireLock(paths.lock);
const store = new SqliteStore(paths.database);
store.migrate("core", CORE_MIGRATIONS);
const token = ensureToken(paths.token);

// Disabled modules come from ~/.pi-spore/settings.json once the settings module lands.
const modules = await setupModules(serverModules, [], {
  log,
  store,
  home: paths,
  exec,
  now: Date.now,
  newId: () => newId(),
});

const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = createApp({
  version: readVersion(),
  modules,
  startedAt,
  now: Date.now,
  token,
  store,
  log,
  ...(existsSync(webDist) ? { webDist } : {}),
});

// Loopback only (R1.2).
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  log.info(`pi-spore server listening on http://127.0.0.1:${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    store.close();
    releaseLock();
    process.exit(0);
  });
}
