import { mkdirSync, watch } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { AgentsKey } from "@pi-spore/mod-agents/server";
import { HomeItemsKey } from "@pi-spore/mod-attention/server";
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
  resolveSettings,
  windowViews,
  writeReading,
} from "@pi-spore/router";
import {
  type AgentRole,
  type CalibrationResponse,
  type HomeNotice,
  parseJsonBody,
  type RoutingDecisionsResponse,
  type TokenUseResponse,
  type TokenUseRow,
  type UsagePlansResponse,
  UsageRouterRequest,
  type UsageWarning,
} from "@pi-spore/shared";
import { calibration, type Outcome } from "./calibration.js";
import { fetchCodexUsage, readCodexLogin } from "./codex.js";
import { SessionIndex } from "./tokens.js";

export interface UsageModuleOptions {
  /** Pi's agent folder, whose `sessions/` holds plain `pi` sessions (R18.3). Default: `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
  agentDir?: string;
  /** The Codex CLI's folder, whose `auth.json` is the login the poll uses (ADR 0153). Default: `CODEX_HOME` or `~/.codex`. */
  codexHome?: string;
  fetch?: typeof fetch;
}

const isInside = (folder: string, path: string): boolean =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

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
export function createUsageModule(options: UsageModuleOptions = {}): ServerModule {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const fetchFn = options.fetch ?? globalThis.fetch;
  return {
    id: "usage",
    requires: ["projects", "workspaces", "pipelines", "attention", "agents"],
    core: false,
    setup(host) {
      const projects = host.use(ProjectsKey);
      const workspaces = host.use(WorkspacesKey);
      const pipelines = host.use(PipelinesKey);
      const homeItems = host.use(HomeItemsKey);
      const agents = host.use(AgentsKey);
      const agentDir =
        options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
      const sessions = new SessionIndex(host.home.sessions, join(agentDir, "sessions"));
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

      const plansView = async (): Promise<UsagePlansResponse> => {
        const { pressure, usageMaxAgeMinutes } = await settings();
        const now = host.now();
        const maxAgeMs = usageMaxAgeMinutes * 60_000;
        const { plans, errors } = await readPlans(host.home.root);
        const warnings: UsageWarning[] = [];
        return {
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
      };

      host.routes.get("/plans", async (c) => c.json(await plansView()));

      // R18.4: the warnings show on Home as well as on the Usage page.
      const homeWarnings = async (): Promise<HomeNotice[]> => {
        const { plans, warnings } = await plansView();
        return warnings.map((warning) => ({
          id: `${warning.plan}:${warning.window}`,
          at: plans.find((plan) => plan.plan === warning.plan)?.seenAt ?? host.now(),
          title: warning.message,
          href: "#/usage",
        }));
      };
      homeItems.register("usage", homeWarnings);

      // The router writes the plan files from any Pi process, so this module watches the folder and nudges Home when
      // a plan file changes. Warnings also clear with time, so Home reads them fresh instead of comparing with the
      // last nudge. The watcher does not keep the process alive.
      const usageFolder = join(host.home.root, "usage");
      mkdirSync(usageFolder, { recursive: true });
      watch(usageFolder, { persistent: false }, (_event, name) => {
        if (name?.endsWith(".json")) homeItems.changed();
      }).on("error", (error) =>
        host.log.error("Watching the usage folder failed", { error: String(error) }),
      );

      host.routes.get("/tokens", async (c) => {
        const { tiers } = await settings();
        const known = new Map(workspaces.list().map((workspace) => [workspace.id, workspace]));
        const used = await sessions.scan();
        const allProjects = await projects.list();
        const projectNames = new Map(allProjects.map((project) => [project.id, project.name]));
        // A plain session has no workspace, so its folder names its project: the workspace or project folder that
        // holds it (the deepest one), else the folder's own name.
        const folders = [
          ...allProjects.map((project) => ({ path: project.path, projectId: project.id })),
          ...[...known.values()].map((workspace) => ({
            path: workspace.path,
            projectId: workspace.projectId,
          })),
        ].sort((a, b) => b.path.length - a.path.length);
        const roles = new Map<string, AgentRole>();
        for (const workspaceId of new Set(used.flatMap((s) => s.workspaceId ?? []))) {
          for (const entry of agents.sessionRoles(workspaceId))
            roles.set(entry.sessionFile, entry.role);
        }
        const rows = new Map<string, TokenUseRow>();
        let skippedLines = 0;
        for (const session of used) {
          skippedLines += session.skippedLines;
          const workspace = session.workspaceId ? known.get(session.workspaceId) : undefined;
          const role = roles.get(session.path);
          const folder = session.cwd
            ? folders.find((candidate) => isInside(candidate.path, session.cwd as string))
            : undefined;
          const projectId =
            workspace?.projectId ?? (session.workspaceId ? undefined : folder?.projectId);
          const projectName = session.workspaceId
            ? workspace
              ? (projectNames.get(workspace.projectId) ?? "(removed project)")
              : "(unknown)"
            : (folder && projectNames.get(folder.projectId)) ||
              basename(session.cwd ?? "") ||
              "(unknown)";
          for (const model of session.models) {
            const key = [
              // A plain session's identity is its project, else its folder: names can repeat.
              session.workspaceId ?? `outside:${projectId ?? session.cwd ?? ""}`,
              role ?? "",
              `${model.provider}/${model.model}`,
            ].join("\u0000");
            const local = tiers[`${model.provider}/${model.model}`] === "local";
            const row = rows.get(key) ?? {
              ...(projectId ? { projectId } : {}),
              projectName,
              ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
              workspaceName: session.workspaceId
                ? (workspace?.name ?? "(removed workspace)")
                : "(outside pi-spore)",
              ...(role ? { role } : {}),
              external: !session.workspaceId,
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
              Number(a.external) - Number(b.external) ||
              a.workspaceName.localeCompare(b.workspaceName) ||
              (a.role ?? "").localeCompare(b.role ?? "") ||
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
        const { threshold, heavyThreshold, explore } = await settings();
        const { records, skipped } = await readRecords(host.home.root, Number.POSITIVE_INFINITY);
        const outcomes = host.store
          .all<OutcomeRow>(
            "SELECT agent_id, verdict, ended_at FROM usage_outcomes WHERE verdict IS NOT NULL",
          )
          .map((row) => ({ agentId: row.agent_id, verdict: row.verdict, endedAt: row.ended_at }));
        const body: CalibrationResponse = {
          ...calibration(records, outcomes, threshold, heavyThreshold, skipped),
          explore,
        };
        return c.json(body);
      });

      // Edits only the two keys it was asked about. `resolveSettings` is the one check of the new file (ADR 0144).
      // The whole read, check, and write runs one request at a time, so the temp file name is safe and no change is lost.
      let patching: Promise<unknown> = Promise.resolve();
      const patchRouter = async (request: UsageRouterRequest) => {
        const path = join(host.home.root, "settings.json");
        const bad = (message: string) => new ApiError(422, "bad_settings", message);
        const isObject = (value: unknown): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && !Array.isArray(value);
        const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "{}";
          throw error;
        });
        let file: unknown;
        try {
          file = JSON.parse(text);
        } catch {
          throw bad(`${path} is not valid JSON`);
        }
        // Spreading a null, array, or number would turn a bad file into a valid one.
        if (!isObject(file)) throw bad(`${path} must hold a JSON object`);
        if (file.router !== undefined && !isObject(file.router)) {
          throw bad(`"router" in ${path} must be a JSON object`);
        }
        const router = { ...file.router };
        if (request.threshold !== undefined) router.threshold = request.threshold;
        if (request.explore === 0) delete router.explore;
        const next = { ...file, router };
        let resolved: ReturnType<typeof resolveSettings>;
        try {
          resolved = resolveSettings(next, path);
        } catch (error) {
          throw bad((error as Error).message);
        }
        await mkdir(host.home.root, { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
        await rename(temp, path);
        return { threshold: resolved.threshold, explore: resolved.explore };
      };

      host.routes.patch("/router", async (c) => {
        const request = parseJsonBody(UsageRouterRequest, await c.req.text(), "router request");
        const result = patching.then(() => patchRouter(request));
        patching = result.catch(() => undefined);
        return c.json(await result);
      });
    },
  };
}

export const usageModule = createUsageModule();
