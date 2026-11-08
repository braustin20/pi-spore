import { existsSync } from "node:fs";
import { AgentsKey } from "@pi-spore/mod-agents/server";
import { CardsKey } from "@pi-spore/mod-kanban/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
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
import { type BotComment, Gh, type GhCommand, jobIdOf, tail } from "./gh.js";

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

/** Runs a poll later and returns a function that cancels it. Tests pass their own to run polls on demand. */
export type PrTimer = (run: () => Promise<void>, ms: number) => () => void;

const realTimer: PrTimer = (run, ms) => {
  const handle = setTimeout(() => void run(), ms);
  // A pending poll must not keep the server process alive.
  handle.unref();
  return () => clearTimeout(handle);
};

export interface GithubPrModuleOptions {
  gh?: GhCommand;
  timer?: PrTimer;
  /** Automatic tries in a row before the watch waits for the user (R9.2). */
  maxTries?: number;
  /** Poll interval after a change, doubling up to `maxIntervalMs` while nothing changes. */
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

/** A short, single-line form of a check list, to see whether anything changed between polls. */
const checksKey = (pr: PullRequest) =>
  pr.checks.map((check) => `${check.name}=${check.state}`).join(",");

const LOG_LINES = 80;
const LOG_CHARS = 8 * 1024;
const MAX_LOGS = 5;

/** Defaults: 3 tries, polls every 30 s after a change and up to every 5 min. */
export function createGithubPrModule(options: GithubPrModuleOptions = {}): ServerModule {
  const maxTries = options.maxTries ?? 3;
  const minInterval = options.minIntervalMs ?? 30_000;
  const maxInterval = options.maxIntervalMs ?? 5 * 60_000;
  const timer = options.timer ?? realTimer;
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
      const scheduled = new Map<string, () => void>();
      /** One poll per workspace at a time; a later request waits for the running one. */
      const running = new Map<string, Promise<void>>();

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

      const unschedule = (workspaceId: string) => {
        scheduled.get(workspaceId)?.();
        scheduled.delete(workspaceId);
      };

      const schedule = (workspaceId: string, ms: number) => {
        unschedule(workspaceId);
        update(workspaceId, { next_poll_at: host.now() + ms, interval_ms: ms });
        scheduled.set(
          workspaceId,
          timer(() => {
            scheduled.delete(workspaceId);
            return poll(workspaceId);
          }, ms),
        );
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
        if (after.state === "merged")
          cards.workChanged(workspaceId, "done", `PR #${after.number} merged`);
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

      /** Looks at the PR, sends failures to the worker when due, and schedules the next look (R9.2). */
      const pollOnce = async (workspaceId: string): Promise<void> => {
        const row = load(workspaceId);
        if (!row) return;
        const workspace = workspaces.get(workspaceId);
        // A parked workspace's agents are stopped; an archived one has no folder. Resume schedules again.
        if (workspace.state !== "active" || !existsSync(workspace.path)) return;
        const before = viewOf(row);
        let pr: PullRequest | undefined;
        try {
          pr = await gh.view(workspace.path, String(row.number));
        } catch (error) {
          update(workspaceId, { message: (error as Error).message, polled_at: host.now() });
          if (row.watch_state === "watching" || row.watch_state === "waiting") {
            schedule(workspaceId, Math.min(row.interval_ms * 2, maxInterval));
          }
          return;
        }
        if (!pr) throw new ApiError(404, "pr_not_found", `PR #${row.number} is gone`);
        stateChanged(workspaceId, before, pr);
        const now = host.now();
        update(workspaceId, {
          view: JSON.stringify(pr),
          polled_at: now,
          message: row.watch_state === "waiting" ? row.message : null,
        });
        if (pr.state !== "open") {
          unschedule(workspaceId);
          update(workspaceId, { watch_state: "done", next_poll_at: null });
          return;
        }
        if (row.watch_state === "off" || row.watch_state === "done") return;

        const changed =
          before.headId !== pr.headId ||
          checksKey(before) !== checksKey(pr) ||
          before.mergeable !== pr.mergeable;
        const pending = pr.checks.some((check) => check.state === "pending");
        if (!pending) {
          const failed = pr.checks.filter((check) => check.state === "fail");
          const freshFailures = failed.length > 0 && row.handled_head !== pr.headId;
          const sent = new Set(
            host.store
              .all<{ item: string }>(
                "SELECT item FROM github_pr_sent WHERE workspace_id = ?",
                workspaceId,
              )
              .map((entry) => entry.item),
          );
          const comments = (await gh.botComments(workspace.path, pr.number)).filter(
            (comment) => !sent.has(comment.key),
          );
          if (freshFailures || comments.length > 0) {
            if (row.watch_state === "watching") {
              const worker = activeWorker(workspaceId);
              if (row.tries >= maxTries) {
                update(workspaceId, {
                  watch_state: "waiting",
                  message: `Stopped after ${maxTries} automatic tries in a row. Waiting for you.`,
                });
              } else if (!worker) {
                update(workspaceId, {
                  watch_state: "waiting",
                  message: "The workspace has no worker chat to send failures to. Waiting for you.",
                });
              } else {
                const attempt = row.tries + 1;
                const message = await feedback(
                  workspace.path,
                  pr,
                  freshFailures ? failed : [],
                  comments,
                  attempt,
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
                const head = pr.headId;
                // The delivery, the sent marks, and the try count commit together.
                host.store.transaction(() => {
                  agents.deliver(worker.id, message);
                  for (const comment of comments) {
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
                    head,
                    `Sent ${summary} to the worker (try ${attempt} of ${maxTries})`,
                  );
                  update(workspaceId, {
                    tries: attempt,
                    ...(freshFailures ? { handled_head: head } : {}),
                  });
                });
              }
            }
          } else if (failed.length === 0 && row.clean_head !== pr.headId) {
            // A head with every check passed and nothing to send ends the run of tries.
            update(workspaceId, {
              tries: 0,
              clean_head: pr.headId,
              watch_state: "watching",
              message: null,
            });
          }
        }
        schedule(workspaceId, changed ? minInterval : Math.min(row.interval_ms * 2, maxInterval));
      };

      const poll = (workspaceId: string): Promise<void> => {
        const previous = running.get(workspaceId) ?? Promise.resolve();
        const next = previous
          .then(() => pollOnce(workspaceId))
          .catch((error: unknown) => {
            host.log.error("PR poll failed", { workspace: workspaceId, error: String(error) });
            update(workspaceId, { message: (error as Error).message });
          })
          .then(() => publishStatus(workspaceId))
          .catch((error: unknown) => {
            host.log.error("PR status failed", { workspace: workspaceId, error: String(error) });
          })
          .finally(() => {
            if (running.get(workspaceId) === next) running.delete(workspaceId);
          });
        running.set(workspaceId, next);
        return next;
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
        if (watch && pr.state === "open") schedule(workspace.id, minInterval);
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

      host.events.onSubscribe(PR_TOPIC, async (topic) => {
        const event: PrEvent = {
          type: "status",
          status: await status(topic.slice(PR_TOPIC.length)),
        };
        return [event];
      });

      // Watches pick up where they were after a restart.
      for (const row of host.store.all<PrRow>(
        "SELECT * FROM github_pr_prs WHERE watch_state IN ('watching', 'waiting')",
      )) {
        schedule(row.workspace_id, minInterval);
      }

      workspaces.afterStateChange((workspace) => {
        if (workspace.state !== "active") unschedule(workspace.id);
        else if (load(workspace.id)) schedule(workspace.id, minInterval);
      });

      // ADR 0121: the PR records of a deleted workspace go with it.
      workspaces.beforeDeleteWorkspace(async (workspace) => {
        unschedule(workspace.id);
        for (const table of ["github_pr_prs", "github_pr_sent", "github_pr_tries"]) {
          host.store.run(`DELETE FROM ${table} WHERE workspace_id = ?`, workspace.id);
        }
      });

      host.routes.get("/workspaces/:id", async (c) => {
        const workspace = workspaces.get(c.req.param("id"));
        if (
          c.req.query("refresh") === "1" &&
          workspace.state === "active" &&
          existsSync(workspace.path)
        ) {
          if (load(workspace.id)) await poll(workspace.id);
          else if (workspace.line && (await providerOf(workspace)).publish) {
            // A PR opened outside pi-spore is shown, but not watched until the user turns the watch on.
            const found = await gh.view(workspace.path, workspace.line);
            if (found) adopt(workspace, found, false);
          }
        }
        return c.json(await status(workspace.id));
      });

      host.routes.post("/workspaces/:id/publish", async (c) => {
        const request = parseJsonBody(PublishRequest, await c.req.text(), "publish request");
        const { workspace, push, line } = await publishable(c.req.param("id"));
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
        return c.json(await status(workspace.id), 201);
      });

      host.routes.post("/workspaces/:id/push", async (c) => {
        parseJsonBody(PushRequest, await c.req.text(), "push request");
        const { workspace, push, line } = await publishable(c.req.param("id"));
        await push({ path: workspace.path, line }, line);
        if (load(workspace.id)) await poll(workspace.id);
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
          if (workspace.state === "active") await poll(workspace.id);
        } else {
          unschedule(workspace.id);
          update(workspace.id, { watch_state: "off", next_poll_at: null, message: null });
          await publishStatus(workspace.id);
        }
        return c.json(await status(workspace.id));
      });
    },
  };
}

export const githubPrModule = createGithubPrModule();
