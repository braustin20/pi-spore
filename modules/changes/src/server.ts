import { existsSync } from "node:fs";
import { AgentsKey } from "@pi-spore/mod-agents/server";
import { type ChangeOps, ProjectsKey, type WorkspaceLocation } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  type AgentStatus,
  type ChangedFileList,
  type ChangeScope,
  ChangeScopeKind,
  type ChangesEvent,
  type ChangesSummary,
  CreateCommentRequest,
  type DiffComment,
  type DiffList,
  type FileDiff,
  parse,
  parseJsonBody,
  type SendCommentsResponse,
  type Workspace,
} from "@pi-spore/shared";

/** Topic of a workspace's change events: `changes:<workspace id>`. */
export const CHANGES_TOPIC = "changes:";

const MIGRATIONS = [
  `CREATE TABLE changes_comments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    side TEXT NOT NULL,
    line INTEGER NOT NULL,
    code TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  )`,
  "CREATE INDEX changes_comments_by_workspace ON changes_comments (workspace_id, sent_at)",
];

interface CommentRow {
  id: string;
  workspace_id: string;
  path: string;
  side: DiffComment["side"];
  line: number;
  code: string;
  body: string;
  created_at: number;
  sent_at: number | null;
}

const toComment = (row: CommentRow): DiffComment => ({
  id: row.id,
  workspaceId: row.workspace_id,
  path: row.path,
  side: row.side,
  line: row.line,
  code: row.code,
  body: row.body,
  createdAt: row.created_at,
  ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
});

export interface ChangesModuleOptions {
  /** Most files a list holds. */
  maxFiles?: number;
  /** Most files with hunks in one diff answer without a path. */
  maxDiffFiles?: number;
  /** Bounds on one file's diff; a larger file shows a note. */
  maxDiffLines?: number;
  maxDiffBytes?: number;
}

/** The message "Send to agent" delivers: each comment with its file, line, and quoted code (R8.3). */
export function commentsMessage(comments: readonly DiffComment[]): string {
  const items = comments.map((comment, index) => {
    const where = `\`${comment.path}\` line ${comment.line}${comment.side === "old" ? " (a removed line, old numbering)" : ""}`;
    const quote = comment.code === "" ? "   > (empty line)" : `   > ${comment.code}`;
    const body = comment.body
      .trim()
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
    return `${index + 1}. ${where}:\n${quote}\n${body}`;
  });
  return `Review comments on your changes. Address each one.\n\n${items.join("\n\n")}`;
}

/** Defaults: 1000 files in a list, 200 with hunks, 3000 lines or 512 KiB per file. */
export function createChangesModule(options: ChangesModuleOptions = {}): ServerModule {
  const maxFiles = options.maxFiles ?? 1000;
  const maxDiffFiles = options.maxDiffFiles ?? 200;
  const limits = {
    maxLines: options.maxDiffLines ?? 3000,
    maxBytes: options.maxDiffBytes ?? 512 * 1024,
  };
  return {
    id: "changes",
    requires: ["projects", "workspaces", "agents"],
    core: false,
    setup(host) {
      host.store.migrate("changes", MIGRATIONS);
      const projects = host.use(ProjectsKey);
      const workspaces = host.use(WorkspacesKey);
      const agents = host.use(AgentsKey);

      interface Target {
        workspace: Workspace;
        ops: ChangeOps;
        location: WorkspaceLocation;
        base: string | undefined;
      }

      const target = async (workspaceId: string): Promise<Target> => {
        const workspace = workspaces.get(workspaceId);
        const project = await projects.get(workspace.projectId);
        const ops = projects.vcsFor(project).changes;
        if (!ops) {
          throw new ApiError(422, "not_supported", `${project.vcs} projects do not show changes`);
        }
        if (!existsSync(workspace.path)) {
          throw new ApiError(
            409,
            "folder_missing",
            `The workspace folder is gone: ${workspace.path}`,
          );
        }
        return {
          workspace,
          ops,
          location: { path: workspace.path, ...(workspace.line ? { line: workspace.line } : {}) },
          base: workspace.base ?? (await ops.defaultBase(project)),
        };
      };

      /** The scope from `?scope=&record=`; the default is uncommitted. */
      const scopeOf = (
        query: (name: string) => string | undefined,
        current: Target,
      ): ChangeScope => {
        const kind = parse(ChangeScopeKind, query("scope") ?? "uncommitted", "scope");
        if (!current.ops.scopes.includes(kind)) {
          throw new ApiError(422, "not_supported", `This project cannot show "${kind}" changes`);
        }
        if (kind === "line") {
          if (!current.base) {
            throw new ApiError(
              409,
              "no_base",
              "The workspace has no base to compare with: no recorded base and no main branch",
            );
          }
          return { kind, base: current.base };
        }
        if (kind === "record") {
          const id = query("record");
          if (!id) throw new ApiError(400, "record_required", "scope=record needs record=<id>");
          return { kind, id };
        }
        return { kind };
      };

      const openComments = (workspaceId: string): DiffComment[] =>
        host.store
          .all<CommentRow>(
            "SELECT * FROM changes_comments WHERE workspace_id = ? AND sent_at IS NULL ORDER BY created_at, id",
            workspaceId,
          )
          .map(toComment);

      const publishComments = (workspaceId: string) => {
        const event: ChangesEvent = { type: "comments", comments: openComments(workspaceId) };
        host.events.publish(`${CHANGES_TOPIC}${workspaceId}`, event);
      };

      host.events.onSubscribe(CHANGES_TOPIC, (topic) => {
        const workspace = workspaces.get(topic.slice(CHANGES_TOPIC.length));
        const event: ChangesEvent = { type: "comments", comments: openComments(workspace.id) };
        return [event];
      });

      // A worker's run that ends has likely changed files, so open Changes tabs refresh (R8).
      const lastStatus = new Map<string, AgentStatus>();
      agents.onChange((agentId, change) => {
        if (change !== "status") return;
        const agent = agents.get(agentId);
        const previous = lastStatus.get(agentId);
        lastStatus.set(agentId, agent.status);
        if (agent.kind !== "worker" || previous !== "busy" || agent.status === "busy") return;
        const event: ChangesEvent = { type: "stale" };
        host.events.publish(`${CHANGES_TOPIC}${agent.workspaceId}`, event);
      });

      host.routes.get("/workspaces/:id", async (c) => {
        const current = await target(c.req.param("id"));
        const body: ChangesSummary = {
          scopes: [...current.ops.scopes],
          ...(current.base ? { base: current.base } : {}),
          records: await current.ops.records(
            current.location,
            current.base,
            current.base ? 100 : 50,
          ),
        };
        return c.json(body);
      });

      host.routes.get("/workspaces/:id/files", async (c) => {
        const current = await target(c.req.param("id"));
        const scope = scopeOf((name) => c.req.query(name), current);
        const body: ChangedFileList = await current.ops.files(current.location, scope, maxFiles);
        return c.json(body);
      });

      host.routes.get("/workspaces/:id/diff", async (c) => {
        const current = await target(c.req.param("id"));
        const scope = scopeOf((name) => c.req.query(name), current);
        const listed = await current.ops.files(current.location, scope, maxFiles);
        const path = c.req.query("path");
        const files = path ? listed.files.filter((file) => file.path === path) : listed.files;
        if (path && files.length === 0) {
          throw new ApiError(404, "file_not_changed", `${path} has no changes in this scope`);
        }
        const diffs: FileDiff[] = [];
        for (const file of files.slice(0, maxDiffFiles)) {
          diffs.push(await current.ops.diff(current.location, scope, file, limits));
        }
        const body: DiffList = {
          diffs,
          truncated: listed.truncated || files.length > maxDiffFiles,
        };
        return c.json(body);
      });

      host.routes.get("/workspaces/:id/comments", (c) => {
        const workspace = workspaces.get(c.req.param("id"));
        return c.json({ comments: openComments(workspace.id) });
      });

      host.routes.post("/workspaces/:id/comments", async (c) => {
        const request = parseJsonBody(CreateCommentRequest, await c.req.text(), "comment");
        const workspace = workspaces.get(c.req.param("id"));
        const row: CommentRow = {
          id: host.newId(),
          workspace_id: workspace.id,
          path: request.path,
          side: request.side,
          line: request.line,
          code: request.code,
          body: request.body.trim(),
          created_at: host.now(),
          sent_at: null,
        };
        if (row.body === "") throw new ApiError(400, "empty_comment", "The comment is empty");
        host.store.run(
          `INSERT INTO changes_comments (id, workspace_id, path, side, line, code, body, created_at, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          row.id,
          row.workspace_id,
          row.path,
          row.side,
          row.line,
          row.code,
          row.body,
          row.created_at,
        );
        publishComments(workspace.id);
        return c.json({ comment: toComment(row) }, 201);
      });

      host.routes.delete("/comments/:id", (c) => {
        const row = host.store.get<CommentRow>(
          "SELECT * FROM changes_comments WHERE id = ?",
          c.req.param("id"),
        );
        if (!row) throw new ApiError(404, "comment_not_found", `No comment ${c.req.param("id")}`);
        if (row.sent_at !== null) {
          throw new ApiError(409, "comment_sent", "The comment was sent to the agent already");
        }
        host.store.run("DELETE FROM changes_comments WHERE id = ?", row.id);
        publishComments(row.workspace_id);
        return c.json({ removed: row.id });
      });

      host.routes.post("/workspaces/:id/comments/send", (c) => {
        const workspace = workspaces.get(c.req.param("id"));
        const comments = openComments(workspace.id);
        if (comments.length === 0) {
          throw new ApiError(409, "no_comments", "There are no comments to send");
        }
        const worker = agents
          .attention()
          .map((entry) => entry.agent)
          .find(
            (agent) =>
              agent.workspaceId === workspace.id && agent.kind === "worker" && agent.active,
          );
        if (!worker) {
          throw new ApiError(
            409,
            "no_worker_chat",
            "The workspace has no worker chat yet. Open its chat first.",
          );
        }
        const sentAt = host.now();
        // The delivery and the sent mark commit together, so a comment is never sent twice or lost.
        host.store.transaction(() => {
          agents.deliver(worker.id, commentsMessage(comments));
          for (const comment of comments) {
            host.store.run(
              "UPDATE changes_comments SET sent_at = ? WHERE id = ?",
              sentAt,
              comment.id,
            );
          }
        });
        publishComments(workspace.id);
        const body: SendCommentsResponse = {
          agentId: worker.id,
          comments: comments.map((comment) => ({ ...comment, sentAt })),
        };
        return c.json(body);
      });
    },
  };
}

export const changesModule = createChangesModule();
