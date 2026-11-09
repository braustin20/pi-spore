import { homedir } from "node:os";
import { join } from "node:path";
import { PipelinesKey } from "@pi-spore/mod-pipelines/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  loadSettings,
  pruneRecords,
  readPlans,
  readRecords,
  readUsageEndpoint,
  windowViews,
  writeReading,
} from "@pi-spore/router";
import type {
  CalibrationResponse,
  RoutingDecisionsResponse,
  TokenUseResponse,
  TokenUseRow,
  UsagePlansResponse,
  UsageWarning,
} from "@pi-spore/shared";
import { calibration, type Outcome } from "./calibration.js";
import { fetchCodexUsage, readCodexLogin } from "./codex.js";
import { SessionIndex } from "./tokens.js";

const WINDOW_NAMES: Readonly<Record<string, string>> = { "5h": "5-hour", "7d": "weekly" };
const planTitle = (plan: string): string =>
  plan === "claude" ? "Claude" : plan === "codex" ? "Codex" : plan;

/** A warning per fresh window that is full or over its pressure threshold (R18.4). */
export function warningsFor(
  plan: string,
  windows: readonly { name: string; utilization: number; stale?: string }[],
  pressure: { weekly: number; fiveHour: number },
): UsageWarning[] {
  return windows.flatMap((window) => {
    if (window.stale) return [];
    const title = `${planTitle(plan)} ${WINDOW_NAMES[window.name] ?? window.name} window`;
    const percent = `${Math.round(window.utilization * 100)}%`;
    const base = { plan, window: window.name, utilization: window.utilization };
    if (window.utilization >= 1) return [{ ...base, message: `${title} is full (${percent}).` }];
    const threshold =
      window.name === "7d" ? pressure.weekly : window.name === "5h" ? pressure.fiveHour : undefined;
    // As in the router: weekly counts above its threshold, 5-hour at or above it (R4.10).
    const over =
      threshold !== undefined &&
      (window.name === "5h" ? window.utilization >= threshold : window.utilization > threshold);
    if (!over) return [];
    return [
      {
        ...base,
        message: `${title} is at ${percent}, over the ${Math.round(threshold * 100)}% threshold.`,
      },
    ];
  });
}

const CODEX_POLL_JOB = "usage.codex-poll";
/** ChatGPT's usage endpoint is asked once a minute (ADR 0153). */
const CODEX_POLL_MS = 60_000;
const NOT_ENDED = ["running", "waiting", "interrupted"] as const;

const MIGRATIONS = [
  `CREATE TABLE usage_outcomes (
    run_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    state TEXT NOT NULL,
    verdict TEXT,
    review_rounds INTEGER NOT NULL,
    fix_passes INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  )`,
];

interface OutcomeRow {
  agent_id: string;
  verdict: Outcome["verdict"];
  ended_at: number;
}

/**
 * Subscription usage (R18, ADR 0022): plan windows from the files the router's usage tap writes, token use from
 * pi-spore's session files, and the router's decisions. The router extension writes those files in any Pi process,
 * so this module reads them on each request. It owns one table, `usage_outcomes` (ADR 0144): how each pipeline run
 * with a worker ended, to judge the router's local choices against its decisions.
 * Codex windows are polled instead: the user's `openai` login reports none (ADR 0153).
 */
export function createUsageModule(
  options: { codexHome?: string; fetch?: typeof fetch } = {},
): ServerModule {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const fetchFn = options.fetch ?? globalThis.fetch;
  return {
    id: "usage",
    requires: ["projects", "workspaces", "pipelines"],
    core: false,
    setup(host) {
      const projects = host.use(ProjectsKey);
      const workspaces = host.use(WorkspacesKey);
      const pipelines = host.use(PipelinesKey);
      const sessions = new SessionIndex(host.home.sessions);
      const settings = () =>
        loadSettings(host.home.root).catch((error: unknown) => {
          throw new ApiError(422, "bad_settings", (error as Error).message);
        });

      host.store.migrate("usage", MIGRATIONS);

      // Runs inside the pipelines transaction. The verdict is the last review of the first reviewer stage.
      pipelines.afterRunEnded((run) => {
        if (!run.workerAgentId) return;
        const reviews = run.turns.filter((turn) => turn.kind === "review");
        const firstStage = Math.min(...reviews.map((turn) => turn.stageIndex));
        const verdict = reviews.findLast(
          (turn) => turn.stageIndex === firstStage && turn.report?.verdict,
        )?.report?.verdict;
        host.store.run(
          "INSERT OR REPLACE INTO usage_outcomes (run_id, workspace_id, agent_id, state, verdict, review_rounds, fix_passes, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          run.id,
          run.workspaceId,
          run.workerAgentId,
          run.state,
          verdict ?? null,
          reviews.length,
          run.turns.filter((turn) => turn.kind === "fix").length,
          run.endedAt ?? host.now(),
        );
      });

      // ADR 0121: the router writes this file from any Pi process, so only this server trims it.
      workspaces.onRetention(async (cutoff) => {
        host.store.run("DELETE FROM usage_outcomes WHERE ended_at < ?", cutoff);
        const count = await pruneRecords(host.home.root, cutoff);
        if (count > 0) host.log.info("Retention deleted routing decisions", { count });
      });

      /** The last poll failure, shown on `/plans`; undefined once a poll answers. */
      let codexError: string | undefined;
      // ADR 0153: the Codex CLI login works on ChatGPT's usage endpoint, where the user's Pi `openai` login gets 401.
      host.jobs.define<Record<string, never>, never>(CODEX_POLL_JOB, [
        {
          name: "poll",
          run: async () => {
            try {
              const body = await fetchCodexUsage(readCodexLogin(codexHome), fetchFn);
              await writeReading(host.home.root, readUsageEndpoint(body), host.now());
              codexError = undefined;
            } catch (error) {
              // A failed poll never ends the job: an expired login should not stop the router seeing usage.
              const message = error instanceof Error ? error.message : String(error);
              if (message !== codexError) host.log.warn("Codex usage poll failed", { message });
              codexError = message;
            }
            return { next: "poll", after: CODEX_POLL_MS };
          },
        },
      ]);

      // The server polls once at start, then every interval. Jobs from before the restart give way to the new one.
      host.onStarted(() => {
        for (const job of host.jobs.list({ kind: CODEX_POLL_JOB, key: "all", states: NOT_ENDED })) {
          host.jobs.cancel(job.id);
        }
        host.jobs.start(CODEX_POLL_JOB, {}, { key: "all", after: 0 });
      });

      host.routes.get("/plans", async (c) => {
        const { pressure, usageMaxAgeMinutes } = await settings();
        const now = host.now();
        const maxAgeMs = usageMaxAgeMinutes * 60_000;
        const { plans, errors } = await readPlans(host.home.root);
        const warnings: UsageWarning[] = [];
        const body: UsagePlansResponse = {
          plans: plans.map((snapshot) => {
            const windows = windowViews(snapshot, now, maxAgeMs).map((view) => ({
              ...view,
              ageMs: now - view.seenAt,
            }));
            warnings.push(...warningsFor(snapshot.plan, windows, pressure));
            return {
              plan: snapshot.plan,
              ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
              source: snapshot.source,
              seenAt: snapshot.seenAt,
              ageMs: now - snapshot.seenAt,
              windows,
            };
          }),
          warnings,
          thresholds: pressure,
          maxAgeMinutes: usageMaxAgeMinutes,
          errors: [...errors, ...(codexError === undefined ? [] : [`Codex usage: ${codexError}`])],
        };
        return c.json(body);
      });

      host.routes.get("/tokens", async (c) => {
        const { tiers } = await settings();
        const known = new Map(workspaces.list().map((workspace) => [workspace.id, workspace]));
        const projectNames = new Map(
          (await projects.list()).map((project) => [project.id, project.name]),
        );
        const rows = new Map<string, TokenUseRow>();
        let skippedLines = 0;
        const used = await sessions.scan();
        for (const session of used) {
          skippedLines += session.skippedLines;
          const workspace = known.get(session.workspaceId);
          for (const model of session.models) {
            const key = `${session.workspaceId}\u0000${model.provider}/${model.model}`;
            const local = tiers[`${model.provider}/${model.model}`] === "local";
            const row = rows.get(key) ?? {
              ...(workspace ? { projectId: workspace.projectId } : {}),
              projectName: workspace
                ? (projectNames.get(workspace.projectId) ?? "(removed project)")
                : "(unknown)",
              workspaceId: session.workspaceId,
              workspaceName: workspace?.name ?? "(removed workspace)",
              provider: model.provider,
              model: model.model,
              local,
              requests: 0,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
            };
            row.requests += model.requests;
            row.input += model.input;
            row.output += model.output;
            row.cacheRead += model.cacheRead;
            row.cacheWrite += model.cacheWrite;
            // R18.2: local models are free, whatever price the catalog lists.
            if (!local) row.cost += model.cost;
            rows.set(key, row);
          }
        }
        const body: TokenUseResponse = {
          rows: [...rows.values()].sort(
            (a, b) =>
              a.projectName.localeCompare(b.projectName) ||
              a.workspaceName.localeCompare(b.workspaceName) ||
              b.input + b.output - (a.input + a.output),
          ),
          sessions: used.length,
          skippedLines,
        };
        return c.json(body);
      });

      host.routes.get("/routing", async (c) => {
        const raw = c.req.query("limit") ?? "50";
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw new ApiError(400, "bad_limit", "limit must be a whole number from 1 to 500");
        }
        const { records, skipped } = await readRecords(host.home.root, limit);
        const body: RoutingDecisionsResponse = { decisions: records, skipped };
        return c.json(body);
      });

      host.routes.get("/calibration", async (c) => {
        const { threshold, heavyThreshold } = await settings();
        const { records, skipped } = await readRecords(host.home.root, Number.POSITIVE_INFINITY);
        const outcomes = host.store
          .all<OutcomeRow>(
            "SELECT agent_id, verdict, ended_at FROM usage_outcomes WHERE verdict IS NOT NULL",
          )
          .map((row) => ({ agentId: row.agent_id, verdict: row.verdict, endedAt: row.ended_at }));
        const body: CalibrationResponse = calibration(
          records,
          outcomes,
          threshold,
          heavyThreshold,
          skipped,
        );
        return c.json(body);
      });
    },
  };
}

export const usageModule = createUsageModule();
