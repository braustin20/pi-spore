import { createHash } from "node:crypto";
import {
  ApiError,
  BRIDGE_CALLER,
  type BridgeCaller,
  type Logger,
  type Store,
} from "@pi-spore/module-api";
import {
  type HealthResponse,
  type Job,
  type JobList,
  JobState,
  parse,
  ValidationError,
} from "@pi-spore/shared";
import { Hono } from "hono";
import type { AgentTokenStore } from "./agent-tokens.js";
import { isLoopbackHost } from "./guards.js";
import type { JobService } from "./jobs.js";
import { tokensMatch } from "./token.js";
import { serveWeb } from "./web.js";

export interface AppOptions {
  version: string;
  /** Enabled modules in setup order, with the routes each one registered. */
  modules: readonly { id: string; routes: Hono }[];
  startedAt: number;
  now: () => number;
  token: string;
  /** Tokens of agent processes, valid only on bridge routes. */
  agentTokens: AgentTokenStore;
  store: Store;
  jobs: JobService;
  log: Logger;
  /** Built web app to serve at `/`. Absent in tests and when the web app is not built. */
  webDist?: string;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Routes of the bridge module: spore-bridge calls from agents, which carry an agent token (architecture 2). */
const BRIDGE_PREFIX = "/api/bridge/";

export const CORE_MIGRATIONS = [
  `CREATE TABLE core_idempotency (
    key TEXT PRIMARY KEY,
    request TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE core_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    key TEXT,
    subject TEXT NOT NULL,
    state TEXT NOT NULL,
    step TEXT NOT NULL,
    checkpoint TEXT,
    run_at INTEGER,
    started_at INTEGER,
    attempts INTEGER NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX core_jobs_state ON core_jobs (state)",
  "CREATE INDEX core_jobs_kind_key ON core_jobs (kind, key)",
];

const NOT_ENDED: readonly JobState[] = ["running", "waiting", "interrupted"];

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  // DNS rebinding: a web page can point its own domain at 127.0.0.1. Its requests then carry that domain as Host.
  app.use("*", async (c, next) => {
    if (!isLoopbackHost(c.req.header("host"))) {
      return c.json(
        { error: { code: "bad_host", message: "pi-spore answers only on loopback hosts" } },
        403,
      );
    }
    await next();
  });

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: options.version,
      uptimeMs: Math.max(0, Math.floor(options.now() - options.startedAt)),
      modules: options.modules.map((module) => module.id),
    };
    return c.json(body);
  });

  // Every other API route needs the token. A custom header also stops cross-site form posts: browsers cannot add it
  // without a CORS preflight, which this server never approves.
  app.use("/api/*", async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
    // Bridge routes take only agent tokens, and other routes only the user's token, so an agent cannot act as the
    // user.
    if (c.req.path.startsWith(BRIDGE_PREFIX)) {
      const caller = options.agentTokens.find(bearer);
      if (!caller) {
        return c.json(
          { error: { code: "unauthorized", message: "Missing or wrong agent token" } },
          401,
        );
      }
      c.set(BRIDGE_CALLER as never, caller as never);
      return next();
    }
    // An empty header counts as absent, so it cannot hide a valid bearer token.
    if (!tokensMatch(options.token, c.req.header("x-pi-spore-token") || bearer)) {
      return c.json(
        { error: { code: "unauthorized", message: "Missing or wrong pi-spore token" } },
        401,
      );
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const given = c.req.header("idempotency-key");
    if (!MUTATING.has(c.req.method) || given === undefined) return next();
    // An agent's keys are its tool call ids. Scoped to the agent, they are the receipts of R16.3.
    const caller = c.get(BRIDGE_CALLER as never) as BridgeCaller | undefined;
    const key = caller ? `bridge/${caller.agentId}/${given}` : given;
    const bodyHash = createHash("sha256")
      .update(await c.req.raw.clone().text())
      .digest("hex");
    const request = `${c.req.method} ${c.req.path} ${bodyHash}`;
    const stored = options.store.get<{ request: string; status: number; body: string }>(
      "SELECT request, status, body FROM core_idempotency WHERE key = ?",
      key,
    );
    if (stored) {
      if (stored.request !== request) {
        return c.json(
          {
            error: {
              code: "idempotency_mismatch",
              message: "This Idempotency-Key was used for another request",
            },
          },
          422,
        );
      }
      return c.newResponse(stored.body, stored.status as 200, {
        "content-type": "application/json",
      });
    }
    await next();
    // Server errors are not stored, so a retry can succeed.
    if (c.res.status < 500) {
      const body = await c.res.clone().text();
      options.store.run(
        "INSERT OR IGNORE INTO core_idempotency (key, request, status, body, created_at) VALUES (?, ?, ?, ?, ?)",
        key,
        request,
        c.res.status,
        body,
        options.now(),
      );
    }
  });

  const findJob = (id: string): Job => {
    const job = options.jobs.get(id);
    if (!job) throw new ApiError(404, "job_not_found", `No job ${id}`);
    return job;
  };

  app.get("/api/jobs", (c) => {
    const given = c.req.queries("state");
    const states = given ? given.map((state) => parse(JobState, state, "job state")) : NOT_ENDED;
    const body: JobList = { jobs: options.jobs.list({ states }) };
    return c.json(body);
  });

  app.post("/api/jobs/:id/retry", (c) => {
    const job = findJob(c.req.param("id"));
    if (job.state !== "interrupted" && job.state !== "waiting") {
      throw new ApiError(409, "job_not_retryable", `Job ${job.id} is ${job.state}`);
    }
    options.jobs.retry(job.id);
    return c.json(findJob(job.id));
  });

  app.post("/api/jobs/:id/cancel", (c) => {
    const job = findJob(c.req.param("id"));
    if (job.state === "done" || job.state === "cancelled") {
      throw new ApiError(409, "job_not_cancellable", `Job ${job.id} is ${job.state}`);
    }
    options.jobs.cancel(job.id);
    return c.json(findJob(job.id));
  });

  for (const module of options.modules) app.route(`/api/${module.id}`, module.routes);

  app.all("/api/*", (c) =>
    c.json({ error: { code: "not_found", message: `No route ${c.req.path}` } }, 404),
  );

  if (options.webDist) app.get("*", serveWeb(options.webDist, options.token));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof ValidationError) {
      return c.json({ error: { code: "invalid_request", message: error.message } }, 400);
    }
    options.log.error("Unhandled error", {
      path: c.req.path,
      error: String(error),
      stack: (error as Error).stack,
    });
    return c.json(
      { error: { code: "internal", message: "Internal error; see the server log" } },
      500,
    );
  });

  return app;
}
