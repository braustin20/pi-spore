import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  CreateAgentRequest,
  DialogAnswer,
  PromptRequest,
  parseJsonBody,
  SetModelRequest,
  SetThinkingRequest,
} from "@pi-spore/shared";
import { agentEnv, readRoleDefaults, resolveResourceArgs, SPORE_EXTENSIONS } from "./launch.js";
import { AgentManager, type AgentRecord, type ManagerOptions } from "./manager.js";
import type { PiCommand } from "./rpc.js";

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
];

interface Row {
  id: string;
  workspace_id: string;
  role: "worker";
  session_file: string | null;
  created_at: number;
}

const toRecord = (row: Row): AgentRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  role: row.role,
  sessionFile: row.session_file,
  createdAt: row.created_at,
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
  /** Replaces the resolution of the user's Pi setup; tests use it to keep the real one out. */
  resourceArgs?: ManagerOptions["resourceArgs"];
  roleDefaults?: ManagerOptions["roleDefaults"];
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

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
      const workspaces = host.use(WorkspacesKey);
      const projects = host.use(ProjectsKey);
      const agentDir =
        options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
      const exclude = options.excludeExtensions ?? ["npm:pi-lens"];

      const agents = new AgentManager({
        pi: options.pi ?? { command: "pi", args: [] },
        events: host.events,
        log: host.log,
        sessionsDir: host.home.sessions,
        resourceArgs:
          options.resourceArgs ??
          ((cwd) => resolveResourceArgs(cwd, agentDir, exclude, SPORE_EXTENSIONS)),
        roleDefaults: options.roleDefaults ?? ((role) => readRoleDefaults(agentDir, role)),
        env: async (agent, workspace) => {
          const extra: Record<string, string> = {
            PI_SPORE_AGENT_ID: agent.id,
            PI_SPORE_WORKSPACE_ID: workspace.id,
          };
          // Unity worktrees tell unity-mcp which editor is theirs (ADR 0011).
          const project = await projects.get(workspace.projectId);
          if (project.traits.some((trait) => trait.id === "unity"))
            extra.PI_SPORE_UNITY_PROJECT = workspace.path;
          return agentEnv(options.baseEnv ?? process.env, extra);
        },
        workspace: (id) => workspaces.get(id),
        saveSessionFile: (agentId, file) => {
          host.store.run("UPDATE agents_agents SET session_file = ? WHERE id = ?", file, agentId);
        },
        maxLive: options.maxLive ?? 4,
        idleStopMs: options.idleStopMs ?? 10 * 60_000,
        startTimeoutMs: options.startTimeoutMs ?? 30_000,
      });
      manager = agents;
      for (const row of host.store.all<Row>("SELECT * FROM agents_agents"))
        agents.track(toRecord(row));

      // Parking stops agents (R2.3); archiving removes the worktree, so its agent must stop first.
      workspaces.beforeLeaveActive(async (workspace) => {
        const rows = host.store.all<Row>(
          "SELECT * FROM agents_agents WHERE workspace_id = ?",
          workspace.id,
        );
        await Promise.all(rows.map((row) => agents.stop(row.id)));
      });

      host.events.onSubscribe("agent:", (topic) => agents.snapshot(topic.slice("agent:".length)));

      host.routes.get("/", (c) => {
        const workspaceId = c.req.query("workspaceId");
        const rows = workspaceId
          ? host.store.all<Row>(
              "SELECT * FROM agents_agents WHERE workspace_id = ? ORDER BY created_at",
              workspaceId,
            )
          : host.store.all<Row>("SELECT * FROM agents_agents ORDER BY created_at");
        return c.json({ agents: rows.map((row) => agents.view(row.id)) });
      });

      /** One worker per workspace: asking again returns the existing one. */
      host.routes.post("/", async (c) => {
        const request = parseJsonBody(
          CreateAgentRequest,
          await c.req.text(),
          "create agent request",
        );
        const workspace = workspaces.get(request.workspaceId);
        const role = request.role ?? "worker";
        const existing = host.store.get<Row>(
          "SELECT * FROM agents_agents WHERE workspace_id = ? AND role = ?",
          workspace.id,
          role,
        );
        if (existing) return c.json({ agent: agents.view(existing.id) });
        const row: Row = {
          id: host.newId(),
          workspace_id: workspace.id,
          role,
          session_file: null,
          created_at: host.now(),
        };
        host.store.run(
          "INSERT INTO agents_agents (id, workspace_id, role, session_file, created_at) VALUES (?, ?, ?, ?, ?)",
          row.id,
          row.workspace_id,
          row.role,
          row.session_file,
          row.created_at,
        );
        agents.track(toRecord(row));
        return c.json({ agent: agents.view(row.id) }, 201);
      });

      host.routes.get("/:id", (c) => c.json({ agent: agents.view(c.req.param("id")) }));

      host.routes.post("/:id/prompt", async (c) => {
        const request = parseJsonBody(PromptRequest, await c.req.text(), "prompt");
        const disposition = await agents.prompt(
          c.req.param("id"),
          request.message,
          request.whileBusy,
        );
        return c.json({ disposition });
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

      host.routes.get("/:id/models", async (c) => c.json(await agents.models(c.req.param("id"))));

      host.routes.get("/:id/commands", async (c) =>
        c.json({ commands: await agents.commands(c.req.param("id")) }),
      );
    },
  };
}

export const agentsModule = createAgentsModule();
