import { existsSync } from "node:fs";
import { AgentsKey } from "@pi-spore/mod-agents/server";
import { CardsKey } from "@pi-spore/mod-kanban/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule, type StepOutcome } from "@pi-spore/module-api";
import {
  type AgentStatus,
  type PrEvent,
  type PrStatus,
  type PrTry,
  type PrWatchState,
  PublishRequest,
  type PullRequest,
  PushRequest,
  parseJsonBody,
  WatchRequest,
  type Workspace,
} from "@pi-spore/shared";
import { PullRequestsKey } from "./contract.js";
import { type BotComment, Gh, type GhCommand, jobIdOf, tail } from "./gh.js";

export * from "./contract.js";
export type { GhCommand } from "./gh.js";

/** Topic of a workspace's PR status: `github-pr:<workspace id>`. */
export const PR_TOPIC = "github-pr:";

const MIGRATIONS = [
  `CREATE TABLE github_pr_prs (
    workspace_id TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    view TEXT NOT NULL,
    watch_state TEXT NOT NULL,
    tries INTEGER NOT NULL,
    handled_head TEXT,
    clean_head TEXT,
    message TEXT,
    polled_at INTEGER,
    next_poll_at INTEGER,
    interval_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE github_pr_sent (
    workspace_id TEXT NOT NULL,
    item TEXT NOT NULL,
    PRIMARY KEY (workspace_id, item)
  )`,
  `CREATE TABLE github_pr_tries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    head_id TEXT NOT NULL,
    summary TEXT NOT NULL
  )`,
  "CREATE INDEX github_pr_tries_by_workspace ON github_pr_tries (workspace_id, at)",
];

interface PrRow {
  workspace_id: string;
  number: number;
  url: string;
  /** The PullRequest as last seen, as JSON this module wrote. */
  view: string;
  watch_state: PrWatchState;
  tries: number;
  /** The head commit whose failed checks went to the worker already. */
  handled_head: string | null;
  /** The last head commit that passed with nothing to send; it ends a run of tries. */
  clean_head: string | null;
  message: string | null;
  polled_at: number | null;
  next_poll_at: number | null;
  interval_ms: number;
  created_at: number;
}

/** The job kind of a PR watch: key and subject are the workspace id (ADR 0004). */
const WATCH_JOB = "github-pr.watch";
/** The job kind that looks for PRs opened outside pi-spore: one job, key `all`, for every active workspace. */
const DISCOVER_JOB = "github-pr.discover";
const NOT_ENDED = ["running", "waiting", "interrupted"] as const;
const LOG_MESSAGE_CHARS = 200;

export interface GithubPrModuleOptions {
  gh?: GhCommand;
  /** Automatic tries in a row before the watch waits for the user (R9.2). */
  maxTries?: number;
  /** Poll interval after a change, doubling up to `maxIntervalMs` while nothing changes. */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** Time between looks for PRs opened outside pi-spore, at all active workspaces. */
  discoverIntervalMs?: number;
}

/** A short, single-line form of a check list, to see whether anything changed between polls. */
const checksKey = (pr: PullRequest) =>
  pr.checks.map((check) => `${check.name}=${check.state}`).join(",");

const LOG_LINES = 80;
const LOG_CHARS = 8 * 1024;
const MAX_LOGS = 5;

/** Defaults: 3 tries, polls every 30 s after a change and up to every 5 min, looks for new PRs every 5 min. */
export function createGithubPrModule(options: GithubPrModuleOptions = {}): ServerModule {
  const maxTries = options.maxTries ?? 3;
  const minInterval = options.minIntervalMs ?? 30_000;
  const maxInterval = options.maxIntervalMs ?? 5 * 60_000;
  const discoverInterval = options.discoverIntervalMs ?? 5 * 60_000;
  return {
    id: "github-pr",
    requires: ["projects", "workspaces", "agents", "kanban"],
    core: false,
    setup(host) {
      host.store.migrate("github-pr", MIGRATIONS);
      const projects = host.use(ProjectsKey);
      const workspaces = host.use(WorkspacesKey);
      const agents = host.use(AgentsKey);
      const cards = host.use(CardsKey);
      const gh = new Gh(host.exec, options.gh ?? { command: "gh", args: [] });

      const load = (workspaceId: string) =>
        host.store.get<PrRow>("SELECT * FROM github_pr_prs WHERE workspace_id = ?", workspaceId);
      /** The view is JSON this module wrote; anything else is a broken database. */
      const viewOf = (row: PrRow): PullRequest => {
        try {
          return JSON.parse(row.view) as PullRequest;
        } catch {
          throw new Error(`github_pr_prs has a broken view for workspace ${row.workspace_id}`);
        }
      };

      /** Writes the changed fields over the stored row. One fixed statement keeps column names out of the SQL text. */
      const update = (workspaceId: string, fields: Partial<Omit<PrRow, "workspace_id">>) => {
        const row = load(workspaceId);
        if (!row) return;
        const next = { ...row, ...fields };
        host.store.run(
          `UPDATE github_pr_prs SET view = ?, watch_state = ?, tries = ?, handled_head = ?, clean_head = ?,
             message = ?, polled_at = ?, next_poll_at = ?, interval_ms = ?
           WHERE workspace_id = ?`,
          next.view,
          next.watch_state,
          next.tries,
          next.handled_head,
          next.clean_head,
          next.message,
          next.polled_at,
          next.next_poll_at,
          next.interval_ms,
          workspaceId,
        );
      };

      const activeWorker = (workspaceId: string) =>
        agents
          .attention()
          .map((entry) => entry.agent)
          .find(
            (agent) => agent.workspaceId === workspaceId && agent.kind === "worker" && agent.active,
          );

      const providerOf = async (workspace: Workspace) =>
        projects.vcsFor(await projects.get(workspace.projectId));

      const status = async (workspaceId: string): Promise<PrStatus> => {
        const workspace = workspaces.get(workspaceId);
        const project = await projects.get(workspace.projectId);
        const provider = projects.vcsFor(project);
        const card = cards.forWorkspace(workspace.id)[0];
        const reason = !provider.publish
          ? `${project.vcs} projects cannot be published`
          : !workspace.line
            ? "The workspace works in the main checkout, not on its own branch"
            : undefined;
        const row = load(workspace.id);
        const base = workspace.base ?? (await provider.changes?.defaultBase(project));
        const folder = existsSync(workspace.path);
        const location = { path: workspace.path };
        const local =
          provider.changes && folder
            ? {
                headId: await provider.changes.head(location),
                uncommitted: (await provider.changes.files(location, { kind: "uncommitted" }, 1000))
                  .files.length,
              }
            : { uncommitted: 0 };
        const tries = host.store
          .all<{ at: number; head_id: string; summary: string }>(
            "SELECT at, head_id, summary FROM github_pr_tries WHERE workspace_id = ? ORDER BY at DESC, id DESC LIMIT 10",
            workspace.id,
          )
          .map((entry): PrTry => ({ at: entry.at, headId: entry.head_id, summary: entry.summary }));
        return {
          workspaceId: workspace.id,
          publishable: reason === undefined,
          ...(reason ? { reason } : {}),
          defaults: {
            title: workspace.name,
            body: card?.body ?? "",
            ...(base ? { base: base.replace(/^origin\//, "") } : {}),
          },
          ...(row ? { pr: viewOf(row) } : {}),
          watch: {
            state: row?.watch_state ?? "off",
            tries: row?.tries ?? 0,
            maxTries,
            ...(row?.polled_at ? { polledAt: row.polled_at } : {}),
            ...(row?.next_poll_at ? { nextPollAt: row.next_poll_at } : {}),
            ...(row?.message ? { message: row.message } : {}),
          },
          tries,
          local: {
            ...(local.headId ? { headId: local.headId } : {}),
            uncommitted: local.uncommitted,
          },
        };
      };

      const publishStatus = async (workspaceId: string) => {
        const event: PrEvent = { type: "status", status: await status(workspaceId) };
        host.events.publish(`${PR_TOPIC}${workspaceId}`, event);
      };

      const cancelWatchJobs = (workspaceId: string) => {
        for (const job of host.jobs.list({
          kind: WATCH_JOB,
          key: workspaceId,
          states: NOT_ENDED,
        })) {
          host.jobs.cancel(job.id);
        }
      };

      /** Starts the one watch job of the workspace, `after` ms from now, in place of any older one. */
      const startWatch = (workspaceId: string, after: number) => {
        cancelWatchJobs(workspaceId);
        update(workspaceId, {
          next_poll_at: after > 0 ? host.now() + after : null,
          interval_ms: minInterval,
        });
        host.jobs.start(WATCH_JOB, { workspaceId }, { key: workspaceId, after });
      };

      /** Moves the workspace's card when the PR opens or merges (ADR 0012, ADR 0040). */
      const stateChanged = (
        workspaceId: string,
        before: PullRequest | undefined,
        after: PullRequest,
      ) => {
        if (before?.state === after.state) return;
        if (after.state === "open")
          cards.workChanged(workspaceId, "review", `PR #${after.number} opened`);
        if (after.state === "merged") {
          // A PR found already merged was never seen open; the card's history still shows both steps. A Done card
          // never goes back to Review.
          if (!before && cards.forWorkspace(workspaceId).every((card) => card.column !== "done"))
            cards.workChanged(workspaceId, "review", `PR #${after.number} opened`);
          cards.workChanged(workspaceId, "done", `PR #${after.number} merged`);
        }
      };

      /** The message for the worker: failed checks with their log tails, then new bot comments. */
      const feedback = async (
        cwd: string,
        pr: PullRequest,
        failed: PullRequest["checks"],
        comments: readonly BotComment[],
        attempt: number,
      ): Promise<string> => {
        const parts = [
          `Pull request #${pr.number} (${pr.url}) needs work. This is automatic try ${attempt} of ${maxTries}.`,
        ];
        if (failed.length > 0) {
          const checks: string[] = [];
          for (const [index, check] of failed.entries()) {
            const name = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
            let entry = `- ${name}${check.url ? `: ${check.url}` : ""}`;
            const job = index < MAX_LOGS ? jobIdOf(check.url) : undefined;
            if (job) {
              const { log, error } = await gh.failedLog(cwd, job);
              entry += log
                ? `\n  Log tail:\n\`\`\`\`\n${tail(log, LOG_LINES, LOG_CHARS)}\n\`\`\`\``
                : `\n  (The log could not be read: ${error})`;
            }
            checks.push(entry);
          }
          parts.push(`Failed checks on commit ${pr.headId.slice(0, 12)}:\n${checks.join("\n")}`);
        }
        if (comments.length > 0) {
          const lines = comments.map((comment) => {
            const where = comment.path
              ? ` on \`${comment.path}\`${comment.line ? ` line ${comment.line}` : ""}`
              : "";
            const body = comment.body
              .split("\n")
              .map((line) => `  > ${line}`)
              .join("\n");
            return `- ${comment.author}${where} (${comment.url}):\n${body}`;
          });
          parts.push(`New review comments from bots:\n${lines.join("\n")}`);
        }
        parts.push(
          "Fix what needs fixing, commit, and push the branch again. Do not force-push. Do not merge or close the pull request.",
        );
        return parts.join("\n\n");
      };

      /**
       * Looks at the PR, decides whether the worker gets failures, and returns the store writes as `commit`, with the
       * next poll (R9.2). Only this job sends feedback, so a refresh cannot race it into a second send.
       */
      const watchStep = async (workspaceId: string): Promise<StepOutcome<never>> => {
        const row = load(workspaceId);
        if (!row || row.watch_state === "off" || row.watch_state === "done") return { next: null };
        const workspace = workspaces.get(workspaceId);
        // The watch also ends if the folder is gone; the job is cancelled when the workspace is parked or archived.
        if (workspace.state !== "active" || !existsSync(workspace.path)) return { next: null };
        const before = viewOf(row);
        const now = host.now();
        let pr: PullRequest | undefined;
        try {
          pr = await gh.view(workspace.path, String(row.number));
        } catch (error) {
          const interval = Math.min(row.interval_ms * 2, maxInterval);
          return {
            next: "poll",
            after: interval,
            commit: () =>
              update(workspaceId, {
                message: (error as Error).message,
                polled_at: now,
                next_poll_at: now + interval,
                interval_ms: interval,
              }),
          };
        }
        if (!pr) throw new ApiError(404, "pr_not_found", `PR #${row.number} is gone`);
        const found = pr;
        const fields: Partial<PrRow> = {
          view: JSON.stringify(found),
          polled_at: now,
          message: row.watch_state === "waiting" ? row.message : null,
        };
        if (found.state !== "open") {
          return {
            next: null,
            commit: () => {
              stateChanged(workspaceId, before, found);
              update(workspaceId, { ...fields, watch_state: "done", next_poll_at: null });
            },
          };
        }

        const changed =
          before.headId !== found.headId ||
          checksKey(before) !== checksKey(found) ||
          before.mergeable !== found.mergeable;
        let send:
          | { workerId: string; message: string; comments: BotComment[]; summary: string }
          | undefined;
        const pending = found.checks.some((check) => check.state === "pending");
        if (!pending) {
          const failed = found.checks.filter((check) => check.state === "fail");
          const freshFailures = failed.length > 0 && row.handled_head !== found.headId;
          const sent = new Set(
            host.store
              .all<{ item: string }>(
                "SELECT item FROM github_pr_sent WHERE workspace_id = ?",
                workspaceId,
              )
              .map((entry) => entry.item),
          );
          const comments = (await gh.botComments(workspace.path, found.number)).filter(
            (comment) => !sent.has(comment.key),
          );
          if (freshFailures || comments.length > 0) {
            if (row.watch_state === "watching") {
              const worker = activeWorker(workspaceId);
              if (row.tries >= maxTries) {
                fields.watch_state = "waiting";
                fields.message = `Stopped after ${maxTries} automatic tries in a row. Waiting for you.`;
              } else if (!worker) {
                fields.watch_state = "waiting";
                fields.message =
                  "The workspace has no worker chat to send failures to. Waiting for you.";
              } else {
                const message = await feedback(
                  workspace.path,
                  found,
                  freshFailures ? failed : [],
                  comments,
                  row.tries + 1,
                );
                const summary = [
                  freshFailures
                    ? `${failed.length} failed check${failed.length === 1 ? "" : "s"}`
                    : "",
                  comments.length
                    ? `${comments.length} bot comment${comments.length === 1 ? "" : "s"}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" and ");
                send = { workerId: worker.id, message, comments, summary };
                fields.tries = row.tries + 1;
                if (freshFailures) fields.handled_head = found.headId;
              }
            }
          } else if (failed.length === 0 && row.clean_head !== found.headId) {
            // A head with every check passed and nothing to send ends the run of tries.
            fields.tries = 0;
            fields.clean_head = found.headId;
            fields.watch_state = "watching";
            fields.message = null;
          }
        }
        const interval = changed ? minInterval : Math.min(row.interval_ms * 2, maxInterval);
        return {
          next: "poll",
          after: interval,
          commit: () => {
            stateChanged(workspaceId, before, found);
            // The delivery, the sent marks, the try, and the row commit together with the next poll time.
            if (send) {
              agents.deliver(send.workerId, send.message);
              for (const comment of send.comments) {
                host.store.run(
                  "INSERT OR IGNORE INTO github_pr_sent (workspace_id, item) VALUES (?, ?)",
                  workspaceId,
                  comment.key,
                );
              }
              host.store.run(
                "INSERT INTO github_pr_tries (id, workspace_id, at, head_id, summary) VALUES (?, ?, ?, ?, ?)",
                host.newId(),
                workspaceId,
                now,
                found.headId,
                `Sent ${send.summary} to the worker (try ${fields.tries} of ${maxTries})`,
              );
            }
            update(workspaceId, { ...fields, next_poll_at: now + interval, interval_ms: interval });
          },
        };
      };

      /** A watch that fails outside gh's view ends with the reason on the row, as a failed poll always did. */
      const runWatchStep = async (workspaceId: string): Promise<StepOutcome<never>> => {
        try {
          return await watchStep(workspaceId);
        } catch (error) {
          host.log.error("PR poll failed", { workspace: workspaceId, error: String(error) });
          return {
            next: null,
            commit: () => update(workspaceId, { message: (error as Error).message }),
          };
        }
      };

      /**
       * Reads the PR and stores the view, and moves the card. It never sends feedback: only the watch job does.
       * Used by a refresh and a push.
       */
      const refreshView = async (workspace: Workspace, row: PrRow): Promise<void> => {
        try {
          const pr = await gh.view(workspace.path, String(row.number));
          if (!pr) throw new ApiError(404, "pr_not_found", `PR #${row.number} is gone`);
          stateChanged(workspace.id, viewOf(row), pr);
          update(workspace.id, {
            view: JSON.stringify(pr),
            polled_at: host.now(),
            message: row.watch_state === "waiting" ? row.message : null,
            ...(pr.state !== "open" ? { watch_state: "done", next_poll_at: null } : {}),
          });
          if (pr.state !== "open") cancelWatchJobs(workspace.id);
        } catch (error) {
          update(workspace.id, { message: (error as Error).message, polled_at: host.now() });
        }
        await publishStatus(workspace.id);
      };

      /** Stores a PR pi-spore has not seen yet for this workspace. */
      const adopt = (workspace: Workspace, pr: PullRequest, watch: boolean) => {
        host.store.run(
          `INSERT INTO github_pr_prs (workspace_id, number, url, view, watch_state, tries, interval_ms, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          workspace.id,
          pr.number,
          pr.url,
          JSON.stringify(pr),
          pr.state !== "open" ? "done" : watch ? "watching" : "off",
          minInterval,
          host.now(),
        );
        stateChanged(workspace.id, undefined, pr);
        if (watch && pr.state === "open") startWatch(workspace.id, minInterval);
      };

      /** Stores the PR of the workspace's branch if there is one and pi-spore has none stored yet. */
      const adoptByBranch = async (workspace: Workspace, line: string): Promise<void> => {
        const found = await gh.view(workspace.path, line);
        // A second look may have stored the PR while gh answered.
        if (!found || load(workspace.id)) return;
        adopt(workspace, found, false);
        await publishStatus(workspace.id);
      };

      const lookFailed = new Set<string>();

      /**
       * Finds the PR of an active workspace that has a card on the board, so its card moves when an agent opened the
       * PR with `gh pr create`. A found PR is not watched. An open PR that nothing watches is followed to merged here;
       * the watch job follows the others.
       */
      const look = async (workspaceId: string): Promise<void> => {
        try {
          const workspace = workspaces.get(workspaceId);
          if (workspace.state !== "active" || !existsSync(workspace.path) || !workspace.line)
            return;
          if (!(await providerOf(workspace)).publish) return;
          if (!cards.forWorkspace(workspace.id).some((card) => card.column !== "done")) return;
          const row = load(workspace.id);
          if (!row) await adoptByBranch(workspace, workspace.line);
          else if (row.watch_state === "off" && viewOf(row).state === "open")
            await refreshView(workspace, row);
        } catch (error) {
          // No GitHub remote or no gh login fails every look, so each workspace says so once.
          if (lookFailed.has(workspaceId)) return;
          lookFailed.add(workspaceId);
          const line = String((error as Error).message).split("\n")[0] ?? "";
          host.log.warn(
            `PR look failed for workspace ${workspaceId}: ${line}`.slice(0, LOG_MESSAGE_CHARS),
          );
        }
      };

      const publishable = async (workspaceId: string) => {
        const workspace = workspaces.get(workspaceId);
        if (workspace.state !== "active") {
          throw new ApiError(409, "workspace_not_active", `The workspace is ${workspace.state}`);
        }
        const provider = await providerOf(workspace);
        if (!provider.publish || !workspace.line) {
          throw new ApiError(
            422,
            "not_supported",
            "Only a workspace on its own branch of a Git project can be published",
          );
        }
        return { workspace, push: provider.publish.push, line: workspace.line };
      };

      /** The one path for the publish route and the `PullRequestsKey` interface. */
      const openPullRequest = async (
        workspaceId: string,
        request: { title: string; body: string; base: string; draft?: boolean },
      ): Promise<PullRequest> => {
        const { workspace, push, line } = await publishable(workspaceId);
        const existing = load(workspace.id);
        if (existing && viewOf(existing).state === "open") {
          throw new ApiError(
            409,
            "pr_exists",
            `PR #${existing.number} is open already: ${existing.url}`,
          );
        }
        const { remote } = await push({ path: workspace.path, line }, line);
        const base = request.base.startsWith(`${remote}/`)
          ? request.base.slice(remote.length + 1)
          : request.base;
        const number = await gh.create(workspace.path, {
          line,
          base,
          title: request.title,
          body: request.body,
          draft: request.draft === true,
        });
        const pr = await gh.view(workspace.path, String(number));
        if (!pr)
          throw new ApiError(422, "gh_failed", `gh cannot find PR #${number} it just opened`);
        if (existing) {
          host.store.run("DELETE FROM github_pr_prs WHERE workspace_id = ?", workspace.id);
          host.store.run("DELETE FROM github_pr_sent WHERE workspace_id = ?", workspace.id);
        }
        adopt(workspace, pr, true);
        host.log.info("PR opened", { workspace: workspace.id, number });
        await publishStatus(workspace.id);
        return pr;
      };

      host.provide(PullRequestsKey, { open: openPullRequest });

      host.events.onSubscribe(PR_TOPIC, async (topic) => {
        const event: PrEvent = {
          type: "status",
          status: await status(topic.slice(PR_TOPIC.length)),
        };
        return [event];
      });

      host.jobs.define<{ workspaceId: string }, never>(WATCH_JOB, [
        { name: "poll", run: ({ subject }) => runWatchStep(subject.workspaceId) },
      ]);

      host.jobs.define<Record<string, never>, never>(DISCOVER_JOB, [
        {
          name: "look",
          run: async () => {
            for (const workspace of workspaces.list({ state: "active" })) await look(workspace.id);
            return { next: "look", after: discoverInterval };
          },
        },
      ]);

      // The server looks once at start, then every interval. Jobs from before the restart give way to the new one.
      host.onStarted(() => {
        for (const job of host.jobs.list({ kind: DISCOVER_JOB, key: "all", states: NOT_ENDED })) {
          host.jobs.cancel(job.id);
        }
        host.jobs.start(DISCOVER_JOB, {}, { key: "all", after: 0 });
      });

      // A run that ends may have opened a PR.
      const lastStatus = new Map<string, AgentStatus>();
      agents.onChange((agentId, change) => {
        if (change !== "status") return;
        const agent = agents.get(agentId);
        const previous = lastStatus.get(agentId);
        lastStatus.set(agentId, agent.status);
        if (previous !== "busy" || agent.status === "busy") return;
        void look(agent.workspaceId);
      });

      // The job commits its writes itself, so its listeners tell the UI. A cancel is followed by the caller's own publish.
      host.jobs.onChange((job) => {
        if (job.kind !== WATCH_JOB || job.key === null || job.state === "cancelled") return;
        publishStatus(job.key).catch((error: unknown) => {
          host.log.error("PR status failed", { workspace: job.key, error: String(error) });
        });
      });

      // Watches from before the runner have no job. Later ones keep the job, and its next poll time, across restarts.
      for (const row of host.store.all<PrRow>(
        "SELECT * FROM github_pr_prs WHERE watch_state IN ('watching', 'waiting')",
      )) {
        const hasJob =
          host.jobs.list({ kind: WATCH_JOB, key: row.workspace_id, states: NOT_ENDED }).length > 0;
        if (hasJob || workspaces.get(row.workspace_id).state !== "active") continue;
        host.jobs.start(
          WATCH_JOB,
          { workspaceId: row.workspace_id },
          { key: row.workspace_id, after: Math.max(0, (row.next_poll_at ?? 0) - host.now()) },
        );
      }

      workspaces.afterStateChange((workspace) => {
        if (workspace.state !== "active") cancelWatchJobs(workspace.id);
        else if (["watching", "waiting"].includes(load(workspace.id)?.watch_state ?? ""))
          startWatch(workspace.id, minInterval);
      });

      // ADR 0121: the PR records of a deleted workspace go with it.
      workspaces.beforeDeleteWorkspace(async (workspace) => {
        cancelWatchJobs(workspace.id);
        host.store.run("DELETE FROM github_pr_prs WHERE workspace_id = ?", workspace.id);
        host.store.run("DELETE FROM github_pr_sent WHERE workspace_id = ?", workspace.id);
        host.store.run("DELETE FROM github_pr_tries WHERE workspace_id = ?", workspace.id);
      });

      host.routes.get("/workspaces/:id", async (c) => {
        const workspace = workspaces.get(c.req.param("id"));
        if (
          c.req.query("refresh") === "1" &&
          workspace.state === "active" &&
          existsSync(workspace.path)
        ) {
          const row = load(workspace.id);
          if (row) await refreshView(workspace, row);
          else if (workspace.line && (await providerOf(workspace)).publish) {
            // A PR opened outside pi-spore is shown, but not watched until the user turns the watch on.
            await adoptByBranch(workspace, workspace.line);
          }
        }
        return c.json(await status(workspace.id));
      });

      host.routes.post("/workspaces/:id/publish", async (c) => {
        const request = parseJsonBody(PublishRequest, await c.req.text(), "publish request");
        await openPullRequest(c.req.param("id"), request);
        return c.json(await status(c.req.param("id")), 201);
      });

      host.routes.post("/workspaces/:id/push", async (c) => {
        parseJsonBody(PushRequest, await c.req.text(), "push request");
        const { workspace, push, line } = await publishable(c.req.param("id"));
        await push({ path: workspace.path, line }, line);
        const row = load(workspace.id);
        if (row) await refreshView(workspace, row);
        return c.json(await status(workspace.id));
      });

      host.routes.post("/workspaces/:id/watch", async (c) => {
        const request = parseJsonBody(WatchRequest, await c.req.text(), "watch request");
        const workspace = workspaces.get(c.req.param("id"));
        const row = load(workspace.id);
        if (!row) throw new ApiError(404, "no_pr", "The workspace has no PR to watch");
        if (viewOf(row).state !== "open") {
          throw new ApiError(409, "pr_not_open", `PR #${row.number} is ${viewOf(row).state}`);
        }
        if (request.on) {
          // Resuming starts a fresh run of tries and sends the current failures again.
          update(workspace.id, {
            watch_state: "watching",
            tries: 0,
            handled_head: null,
            message: null,
            interval_ms: minInterval,
          });
          if (workspace.state === "active") startWatch(workspace.id, 0);
        } else {
          cancelWatchJobs(workspace.id);
          update(workspace.id, { watch_state: "off", next_poll_at: null, message: null });
        }
        await publishStatus(workspace.id);
        return c.json(await status(workspace.id));
      });
    },
  };
}

export const githubPrModule = createGithubPrModule();
