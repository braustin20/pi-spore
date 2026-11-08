import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import { removeInside } from "@pi-spore/module-api/node";
import {
  type Agent,
  type AgentRole,
  type ChatKind,
  CreateAgentRequest,
  CreateChatRequest,
  DialogAnswer,
  orderChats,
  PromptRequest,
  parseJsonBody,
  RenameChatRequest,
  SetModelRequest,
  SetThinkingRequest,
  type Workspace,
} from "@pi-spore/shared";
import { type AgentChange, type Agents, AgentsKey } from "./contract.js";
import {
  DELIVERIES_JOB_MIGRATION,
  DELIVERIES_MIGRATION,
  DELIVERY_JOB,
  Deliveries,
} from "./deliveries.js";
import { checkPromptImages, imageHeaders, readLinkedImage, servableType } from "./images.js";
import { agentEnv, readRoleDefaults, resolveResourceArgs, SPORE_EXTENSIONS } from "./launch.js";
import { AgentManager, type AgentRecord, type ManagerOptions } from "./manager.js";
import type { PiCommand } from "./rpc.js";

export * from "./contract.js";
export type { AgentEvent } from "./manager.js";

const MIGRATIONS = [
  `CREATE TABLE agents_agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    role TEXT NOT NULL,
    session_file TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, role)
  )`,
  "ALTER TABLE agents_agents ADD COLUMN waiting_since INTEGER",
  DELIVERIES_MIGRATION,
  // ADR 0030: many chats per workspace. SQLite cannot drop the UNIQUE constraint, so the table is rebuilt. Each
  // existing worker becomes its workspace's active worker chat.
  `CREATE TABLE agents_agents_v2 (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    active INTEGER NOT NULL,
    title TEXT,
    forked_from TEXT,
    session_file TEXT,
    created_at INTEGER NOT NULL,
    waiting_since INTEGER
  );
  INSERT INTO agents_agents_v2 (id, workspace_id, role, kind, active, session_file, created_at, waiting_since)
    SELECT id, workspace_id, role, 'worker', 1, session_file, created_at, waiting_since FROM agents_agents;
  DROP TABLE agents_agents;
  ALTER TABLE agents_agents_v2 RENAME TO agents_agents;
  CREATE UNIQUE INDEX agents_one_active_worker ON agents_agents (workspace_id)
    WHERE kind = 'worker' AND active = 1;`,
  // ADR 0110: a closed chat leaves the chat bar. Its row and session file stay, so ids held elsewhere stay valid.
  "ALTER TABLE agents_agents ADD COLUMN closed INTEGER NOT NULL DEFAULT 0",
  // ADR 0120: the role of a workspace chat is `orchestrator`; `worker` is a subagent role now. `kind` keeps its values.
  "UPDATE agents_agents SET role = 'orchestrator'",
  // ADR 0120: the model a new chat starts on, `provider/id`. NULL: the role's default.
  "ALTER TABLE agents_agents ADD COLUMN model TEXT",
  // ADR 0121: retention counts a closed chat from the day it was closed.
  "ALTER TABLE agents_agents ADD COLUMN closed_at INTEGER",
  // ADR 0004: a delivery's job on the runner.
  DELIVERIES_JOB_MIGRATION,
];

interface Row {
  id: string;
  workspace_id: string;
  role: AgentRole;
  kind: ChatKind;
  active: number;
  title: string | null;
  forked_from: string | null;
  session_file: string | null;
  created_at: number;
  waiting_since: number | null;
  closed: number;
  model: string | null;
}

const toRecord = (row: Row): AgentRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  role: row.role,
  kind: row.kind,
  active: row.active === 1,
  title: row.title,
  forkedFrom: row.forked_from,
  sessionFile: row.session_file,
  createdAt: row.created_at,
  waitingSince: row.waiting_since,
  closed: row.closed === 1,
  model: row.model,
});

export interface AgentsModuleOptions {
  pi?: PiCommand;
  /** Pi's agent folder, `~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise. */
  agentDir?: string;
  /** Package sources agents do not load (ADR 0025). */
  excludeExtensions?: readonly string[];
  maxLive?: number;
  idleStopMs?: number;
  startTimeoutMs?: number;
  /** How long the model list stays cached, in ms. */
  modelsCacheMs?: number;
  /** Replaces the resolution of the user's Pi setup; tests use it to keep the real one out. */
  resourceArgs?: ManagerOptions["resourceArgs"];
  roleDefaults?: ManagerOptions["roleDefaults"];
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Largest image a message may carry, and largest linked image file the chat shows, decoded (ADR 0060). */
  maxImageBytes?: number;
  maxImagesPerMessage?: number;
  /** Image bytes kept in memory for pages; older ones are read from session files again. */
  imageCacheBytes?: number;
}

const MIB = 1024 * 1024;
const REF = /^[0-9a-f]{64}$/;

/** Defaults from ADR 0025 and ADR 0026. Settings will override them once the settings module lands. */
export function createAgentsModule(
  options: AgentsModuleOptions = {},
): ServerModule & { manager(): AgentManager } {
  let manager: AgentManager | undefined;
  return {
    id: "agents",
    requires: ["projects", "workspaces"],
    core: true,
    manager() {
      if (!manager) throw new Error("The agents module is not set up");
      return manager;
    },
    setup(host) {
      host.store.migrate("agents", MIGRATIONS);
      // The table has no updated_at, so chats closed before the migration count from now (ADR 0121).
      host.store.run(
        "UPDATE agents_agents SET closed_at = ? WHERE closed = 1 AND closed_at IS NULL",
        host.now(),
      );
      const workspaces = host.use(WorkspacesKey);
      const projects = host.use(ProjectsKey);
      const agentDir =
        options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
      const exclude = options.excludeExtensions ?? ["npm:pi-lens"];
      const listeners: ((agentId: string, change: AgentChange) => void)[] = [];
      const chatDeleteListeners: ((agentId: string) => void)[] = [];

      const resourceArgs =
        options.resourceArgs ??
        ((cwd: string) => resolveResourceArgs(cwd, agentDir, exclude, SPORE_EXTENSIONS));

      const agents = new AgentManager({
        pi: options.pi ?? { command: "pi", args: [] },
        events: host.events,
        log: host.log,
        sessionsDir: host.home.sessions,
        resourceArgs,
        roleDefaults: options.roleDefaults ?? ((role) => readRoleDefaults(agentDir, role)),
        env: async (agent, workspace) => {
          const extra: Record<string, string> = {
            PI_SPORE_AGENT_ID: agent.id,
            PI_SPORE_WORKSPACE_ID: workspace.id,
            // spore-bridge gives side chats and stage agents their own rules (ADR 0033, R6).
            PI_SPORE_CHAT_KIND: agent.kind,
          };
          if (agent.kind === "stage") extra.PI_SPORE_STAGE_ROLE = agent.role;
          // Unity worktrees tell unity-mcp which editor is theirs (ADR 0011).
          const project = await projects.get(workspace.projectId);
          if (project.traits.some((trait) => trait.id === "unity"))
            extra.PI_SPORE_UNITY_PROJECT = workspace.path;
          return agentEnv(options.baseEnv ?? process.env, extra);
        },
        url: host.url,
        tokens: host.agentTokens,
        now: host.now,
        workspace: (id) => workspaces.get(id),
        saveSessionFile: (agentId, file) => {
          host.store.run("UPDATE agents_agents SET session_file = ? WHERE id = ?", file, agentId);
        },
        saveWaiting: (agentId, since) => {
          host.store.run("UPDATE agents_agents SET waiting_since = ? WHERE id = ?", since, agentId);
        },
        saveTitle: (agentId, title) => {
          host.store.run("UPDATE agents_agents SET title = ? WHERE id = ?", title, agentId);
        },
        onChange: (agentId, change) => {
          host.events.publish(
            "agents:list",
            agents.isClosed(agentId)
              ? { type: "removed", id: agentId }
              : { type: "agent", agent: agents.view(agentId) },
          );
          for (const listener of listeners) listener(agentId, change);
          if (change === "status" && agents.view(agentId).status === "idle")
            host.jobs.wake(DELIVERY_JOB, agentId);
        },
        maxLive: options.maxLive ?? 8,
        idleStopMs: options.idleStopMs ?? 10 * 60_000,
        startTimeoutMs: options.startTimeoutMs ?? 30_000,
        modelsCacheMs: options.modelsCacheMs ?? 60_000,
        probe: async () => ({
          cwd: host.home.root,
          // No PI_SPORE_URL or token: this process is not an agent and has no bridge.
          env: agentEnv(options.baseEnv ?? process.env, {}),
          args: [...(await resourceArgs(host.home.root)), "--no-session"],
        }),
        imageCacheBytes: options.imageCacheBytes ?? 64 * MIB,
      });
      const imageLimits = {
        maxBytes: options.maxImageBytes ?? 10 * MIB,
        maxCount: options.maxImagesPerMessage ?? 8,
      };
      manager = agents;
      for (const row of host.store.all<Row>("SELECT * FROM agents_agents"))
        agents.track(toRecord(row));

      const queue = new Deliveries({
        store: host.store,
        jobs: host.jobs,
        log: host.log,
        now: host.now,
        newId: host.newId,
        workspaceOf: (agentId) => workspaces.get(agents.view(agentId).workspaceId),
        canRun: (agentId) => agents.view(agentId).active,
        send: async (agentId, message) => {
          await agents.prompt(agentId, message, "followUp");
        },
      });
      workspaces.afterResume((workspace) => {
        const rows = host.store.all<Row>(
          "SELECT * FROM agents_agents WHERE workspace_id = ?",
          workspace.id,
        );
        for (const row of rows) host.jobs.wake(DELIVERY_JOB, row.id);
      });

      // Parking stops agents (R2.3); archiving removes the worktree, so its agent must stop first.
      workspaces.beforeLeaveActive(async (workspace) => {
        const rows = host.store.all<Row>(
          "SELECT * FROM agents_agents WHERE workspace_id = ?",
          workspace.id,
        );
        await Promise.all(rows.map((row) => agents.stop(row.id)));
      });

      host.events.onSubscribe("agent:", (topic) => agents.snapshot(topic.slice("agent:".length)));
      host.events.onSubscribe("agents:list", () => [
        {
          type: "snapshot",
          agents: host.store
            .all<Row>("SELECT * FROM agents_agents WHERE closed = 0")
            .map((row) => agents.view(row.id)),
        },
      ]);

      /** Chat changes of one workspace run one at a time, so it never has two active worker chats. */
      const serial = new Map<string, Promise<unknown>>();
      const inOrder = <T>(workspaceId: string, task: () => Promise<T>): Promise<T> => {
        const next = (serial.get(workspaceId) ?? Promise.resolve()).then(task, task);
        serial.set(
          workspaceId,
          next.catch(() => undefined),
        );
        return next;
      };

      const activeWorker = (workspaceId: string): Row | undefined =>
        host.store.get<Row>(
          "SELECT * FROM agents_agents WHERE workspace_id = ? AND kind = 'worker' AND active = 1",
          workspaceId,
        );

      const insert = (row: Row): Agent => {
        host.store.run(
          `INSERT INTO agents_agents (id, workspace_id, role, kind, active, title, forked_from, session_file, created_at, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          row.id,
          row.workspace_id,
          row.role,
          row.kind,
          row.active,
          row.title,
          row.forked_from,
          row.created_at,
          row.model,
        );
        agents.track(toRecord(row));
        const agent = agents.view(row.id);
        host.events.publish("agents:list", { type: "agent", agent });
        return agent;
      };

      const newRow = (
        workspaceId: string,
        kind: Row["kind"],
        forkedFrom: string | null,
        model: string | null,
        { role, title }: { role: AgentRole; title: string | null } = {
          role: "orchestrator",
          title: null,
        },
      ): Row => ({
        id: host.newId(),
        workspace_id: workspaceId,
        role,
        kind,
        active: 1,
        title,
        forked_from: forkedFrom,
        session_file: null,
        created_at: host.now(),
        waiting_since: null,
        closed: 0,
        model,
      });

      /**
       * The workspace's active worker chat; the first call for a workspace creates it. `model` applies only to a
       * chat created here: an existing chat keeps its own (ADR 0120).
       */
      const ensureWorker = (
        workspaceId: string,
        model?: string,
      ): Promise<{ agent: Agent; created: boolean }> => {
        const workspace = workspaces.get(workspaceId);
        return inOrder(workspace.id, async () => {
          const existing = activeWorker(workspace.id);
          if (existing) return { agent: agents.view(existing.id), created: false };
          requireNotArchived(workspace);
          return {
            agent: insert(newRow(workspace.id, "worker", null, model ?? null)),
            created: true,
          };
        });
      };

      const api: Agents = {
        deliver: (agentId, message) => {
          agents.view(agentId);
          queue.add(agentId, message);
        },
        createStage: (workspaceId, stage) => {
          const workspace = workspaces.get(workspaceId);
          return insert(
            newRow(workspace.id, "stage", null, stage.model ?? null, {
              role: stage.role,
              title: stage.title,
            }),
          );
        },
        roleDefaults: (role) => agents.roleDefaults(role),
        modelsUsed: (agentId) => agents.modelsUsed(agentId),
        activeWorker: async (workspaceId, options) =>
          (await ensureWorker(workspaceId, options?.model)).agent,
        get: (agentId) => agents.view(agentId),
        attention: () => agents.attention(),
        onChange: (listener) => {
          listeners.push(listener);
        },
        beforeDeleteChat: (listener) => {
          chatDeleteListeners.push(listener);
        },
      };
      host.provide(AgentsKey, api);

      // ADR 0121. Deliveries go first: a send already running for a forgotten chat only fails on its next read.
      const dropChat = async (row: Row) => {
        queue.cancelJobs(row.id);
        host.store.run("DELETE FROM agents_deliveries WHERE agent_id = ?", row.id);
        host.store.run("DELETE FROM agents_agents WHERE id = ?", row.id);
        await agents.forget(row.id);
      };

      workspaces.onRetention(async (cutoff) => {
        // An open fork that has not started reads its parent's session on its first start.
        const old = host.store.all<Row>(
          `SELECT * FROM agents_agents AS parent WHERE closed = 1 AND closed_at < ?
             AND NOT EXISTS (SELECT 1 FROM agents_agents AS fork
               WHERE fork.forked_from = parent.id AND fork.closed = 0 AND fork.session_file IS NULL)`,
          cutoff,
        );
        let count = 0;
        for (const row of old) {
          try {
            for (const listener of chatDeleteListeners) listener(row.id);
            if (row.session_file) await removeInside(host.home.sessions, row.session_file);
            await dropChat(row);
            count++;
          } catch (error) {
            host.log.error("Retention could not delete a closed chat", {
              agent: row.id,
              error: String(error),
            });
          }
        }
        if (count > 0) host.log.info("Retention deleted closed chats", { count });
      });

      workspaces.beforeDeleteWorkspace(async (workspace) => {
        const rows = host.store.all<Row>(
          "SELECT * FROM agents_agents WHERE workspace_id = ?",
          workspace.id,
        );
        for (const row of rows) await dropChat(row);
        await removeInside(host.home.sessions, join(host.home.sessions, workspace.id));
      });

      // Retention deletes an archived workspace's chats, so a new row would race it (ADR 0121).
      const requireNotArchived = (workspace: Workspace) => {
        if (workspace.state === "archived") {
          throw new ApiError(
            409,
            "workspace_archived",
            "The workspace is archived; it cannot start a new chat",
          );
        }
      };

      const requireActive = (workspace: Workspace) => {
        if (workspace.state !== "active") {
          throw new ApiError(
            409,
            "workspace_not_active",
            `The workspace is ${workspace.state}; resume it first`,
          );
        }
      };

      /**
       * Turns the workspace's active worker chat into read-only history and stops it (ADR 0030). A run in progress
       * is not cut off: the user stops or aborts it first.
       */
      const retireWorker = async (workspaceId: string): Promise<void> => {
        const current = activeWorker(workspaceId);
        if (!current) return;
        const { status } = agents.view(current.id);
        if (status === "busy" || status === "starting" || status === "waiting") {
          throw new ApiError(
            409,
            "worker_busy",
            "The orchestrator chat is working. Abort or stop it first, then switch chats.",
          );
        }
        host.store.run("UPDATE agents_agents SET active = 0 WHERE id = ?", current.id);
        await agents.setActive(current.id, false);
      };

      host.routes.get("/", (c) => {
        const workspaceId = c.req.query("workspaceId");
        const rows = workspaceId
          ? host.store.all<Row>(
              "SELECT * FROM agents_agents WHERE workspace_id = ? AND closed = 0",
              workspaceId,
            )
          : host.store.all<Row>("SELECT * FROM agents_agents WHERE closed = 0");
        return c.json({ agents: orderChats(rows.map((row) => agents.view(row.id))) });
      });

      /** The workspace's active worker chat; the first call for a workspace creates it. */
      host.routes.post("/", async (c) => {
        const request = parseJsonBody(
          CreateAgentRequest,
          await c.req.text(),
          "create agent request",
        );
        const { agent, created } = await ensureWorker(request.workspaceId, request.model);
        return c.json({ agent }, created ? 201 : 200);
      });

      /**
       * Starts a chat (ADR 0030). A worker chat replaces the active one, which stops and stays readable. A side chat
       * starts empty, or with `fork` from a copy of the active worker chat's context.
       */
      host.routes.post("/chats", async (c) => {
        const request = parseJsonBody(CreateChatRequest, await c.req.text(), "create chat request");
        const workspace = workspaces.get(request.workspaceId);
        if (request.fork && request.kind !== "side")
          throw new ApiError(400, "bad_request", "Only a side chat can start from a fork");
        requireActive(workspace);
        return inOrder(workspace.id, async () => {
          if (request.kind === "worker") {
            await retireWorker(workspace.id);
            return c.json(
              { agent: insert(newRow(workspace.id, "worker", null, request.model ?? null)) },
              201,
            );
          }
          let forkedFrom: string | null = null;
          if (request.fork) {
            const worker = activeWorker(workspace.id);
            if (!worker?.session_file) {
              throw new ApiError(
                409,
                "nothing_to_fork",
                "The orchestrator chat has no messages yet, so there is no context to copy",
              );
            }
            forkedFrom = worker.id;
          }
          return c.json({ agent: insert(newRow(workspace.id, "side", forkedFrom, null)) }, 201);
        });
      });

      /** Makes an older worker chat the active one. The current one stops first. */
      host.routes.post("/:id/activate", async (c) => {
        const target = agents.view(c.req.param("id"));
        if (target.kind !== "worker")
          throw new ApiError(
            409,
            "not_a_worker_chat",
            "Only an orchestrator chat can be made active",
          );
        if (agents.isClosed(target.id))
          throw new ApiError(409, "chat_closed", "This chat is closed");
        requireActive(workspaces.get(target.workspaceId));
        return inOrder(target.workspaceId, async () => {
          if (!agents.view(target.id).active) {
            await retireWorker(target.workspaceId);
            host.store.run("UPDATE agents_agents SET active = 1 WHERE id = ?", target.id);
            await agents.setActive(target.id, true);
            // Answers that came while it was inactive.
            host.jobs.wake(DELIVERY_JOB, target.id);
          }
          return c.json({ agent: agents.view(target.id) });
        });
      });

      /**
       * Closes a chat for good (ADR 0110). A chat that is working is not cut off: the user aborts or stops it first.
       * Closing the active worker chat leaves the workspace without one, so the page's next "get the worker" call
       * starts a fresh chat.
       */
      host.routes.post("/:id/close", async (c) => {
        const id = c.req.param("id");
        const target = agents.view(id);
        return inOrder(target.workspaceId, async () => {
          if (agents.isClosed(id)) return c.json({ ok: true });
          const { status } = agents.view(id);
          if (status === "busy" || status === "starting" || status === "waiting") {
            throw new ApiError(
              409,
              "chat_busy",
              "The chat is working. Abort or stop it first, then close it.",
            );
          }
          host.store.run(
            "UPDATE agents_agents SET active = 0, closed = 1, closed_at = ? WHERE id = ?",
            host.now(),
            id,
          );
          await agents.close(id);
          return c.json({ ok: true });
        });
      });

      host.routes.post("/:id/title", async (c) => {
        const request = parseJsonBody(RenameChatRequest, await c.req.text(), "rename request");
        const id = c.req.param("id");
        const title = request.title.replace(/\s+/g, " ").trim();
        if (!title) throw new ApiError(400, "bad_request", "A chat title needs some text");
        agents.rename(id, title);
        return c.json({ agent: agents.view(id) });
      });

      // Before "/:id", or "models" is read as an agent id.
      host.routes.get("/models", async (c) => c.json({ models: await agents.availableModels() }));

      host.routes.get("/:id", (c) => c.json({ agent: agents.view(c.req.param("id")) }));

      host.routes.post("/:id/prompt", async (c) => {
        const request = parseJsonBody(PromptRequest, await c.req.text(), "prompt");
        const images = checkPromptImages(request.images ?? [], imageLimits);
        if (request.message.trim() === "" && images.length === 0)
          throw new ApiError(400, "empty_prompt", "A message needs text or an image");
        const disposition = await agents.prompt(
          c.req.param("id"),
          request.message,
          request.whileBusy,
          images,
        );
        return c.json({ disposition });
      });

      /** An image block of the chat, by the ref that replaced its data in events and snapshots (ADR 0060). */
      host.routes.get("/:id/images/:ref", async (c) => {
        const ref = c.req.param("ref");
        if (!REF.test(ref)) throw new ApiError(400, "bad_ref", "An image ref is 64 hex digits");
        const image = await agents.image(c.req.param("id"), ref);
        if (!image) throw new ApiError(404, "image_not_found", "This chat has no such image");
        // A ref names its bytes, so they never change.
        return c.body(
          new Uint8Array(image.bytes),
          200,
          imageHeaders(servableType(image.mimeType), "private, max-age=31536000, immutable"),
        );
      });

      /**
       * An image file the agent linked in a message: a path absolute or relative to the workspace folder, served only
       * from inside that folder or the workspace's artifacts folder (ADR 0060).
       */
      host.routes.get("/:id/linked-image", async (c) => {
        const path = c.req.query("path");
        if (!path) throw new ApiError(400, "bad_path", "Give the image path as ?path=");
        const workspace = workspaces.get(agents.view(c.req.param("id")).workspaceId);
        const image = await readLinkedImage(
          path,
          workspace.path,
          [workspace.path, join(host.home.artifacts, "workspaces", workspace.id)],
          imageLimits.maxBytes,
        );
        // The agent may rewrite the file under the same name.
        return c.body(new Uint8Array(image.bytes), 200, imageHeaders(image.mimeType, "no-store"));
      });

      /** The user saw the agent's last reply, so Home stops showing it as waiting. */
      host.routes.post("/:id/seen", (c) => {
        agents.seen(c.req.param("id"));
        return c.json({ ok: true });
      });

      host.routes.post("/:id/abort", async (c) => {
        await agents.abort(c.req.param("id"));
        return c.json({ ok: true });
      });

      host.routes.post("/:id/stop", async (c) => {
        await agents.stop(c.req.param("id"));
        return c.json({ agent: agents.view(c.req.param("id")) });
      });

      host.routes.post("/:id/model", async (c) => {
        const request = parseJsonBody(SetModelRequest, await c.req.text(), "model request");
        const model = await agents.setModel(c.req.param("id"), request.provider, request.modelId);
        return c.json({ model });
      });

      host.routes.post("/:id/thinking", async (c) => {
        const request = parseJsonBody(SetThinkingRequest, await c.req.text(), "thinking request");
        await agents.setThinking(c.req.param("id"), request.level);
        return c.json({ ok: true });
      });

      host.routes.post("/:id/compact", async (c) => {
        await agents.compact(c.req.param("id"));
        return c.json({ ok: true });
      });

      host.routes.post("/:id/dialog", async (c) => {
        const answer = parseJsonBody(DialogAnswer, await c.req.text(), "dialog answer");
        if (
          answer.value === undefined &&
          answer.confirmed === undefined &&
          answer.cancelled !== true
        ) {
          throw new ApiError(400, "empty_answer", "Answer with value, confirmed, or cancelled");
        }
        agents.answerDialog(c.req.param("id"), answer);
        return c.json({ ok: true });
      });

      /** What a helper run did, asked of the agent's process (ADR 0034). `?child=` picks one step. */
      host.routes.get("/:id/children/:runId/transcript", async (c) =>
        c.json({
          transcript: await agents.childTranscript(
            c.req.param("id"),
            c.req.param("runId"),
            c.req.query("child"),
          ),
        }),
      );

      host.routes.get("/:id/models", async (c) => c.json(await agents.models(c.req.param("id"))));

      host.routes.get("/:id/commands", async (c) =>
        c.json({ commands: await agents.commands(c.req.param("id")) }),
      );
    },
  };
}

export const agentsModule = createAgentsModule();
