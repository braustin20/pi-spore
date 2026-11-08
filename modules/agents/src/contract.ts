import { defineInterface } from "@pi-spore/module-api";
import type { Agent, AgentDialog, StageRole, Workspace } from "@pi-spore/shared";
import type { RoleDefaults } from "./launch.js";

/** What changed about an agent. `chat`: its title or active flag. `helpers`: the number of running helpers. */
export type AgentChange = "status" | "dialog" | "waiting" | "chat" | "helpers";

/** One agent with what Home shows about it (R15). */
export interface AgentAttention {
  agent: Agent;
  /** When the agent entered its current status. */
  since: number;
  dialogs: { dialog: AgentDialog; openedAt: number }[];
  /**
   * When its last run ended without an abort, so it waits for the user. Cleared when the user sends it a message,
   * opens its chat, or dismisses it.
   */
  waitingSince?: number;
}

/** What a launch hook adds to one agent's Pi process. */
export interface LaunchContext {
  /** Environment variables added to the agent's process. */
  env?: Record<string, string>;
  /**
   * Replaces the agent's tool allowlist for this launch: `--tools <these> --exclude-tools mcp__*`. At most one hook
   * may give it for one agent.
   */
  tools?: readonly string[];
}

export type LaunchHook = (agent: Agent, workspace: Workspace) => LaunchContext | undefined;

export interface Agents {
  /**
   * Queues a message for the agent as a durable delivery (architecture 6): a prompt when it is idle, a follow-up when
   * it is busy, a start first when it is stopped. A parked workspace keeps it until it is resumed. The row and its
   * job on the runner are written at once, so a caller inside `store.transaction` commits them together with its own
   * changes.
   */
  deliver(agentId: string, message: string): void;
  /**
   * The workspace's active worker chat, created first if the workspace has none yet, as `POST /api/agents` does.
   * Throws a 404 ApiError for an unknown workspace. `model` (`provider/id`) is the model of a chat created by this
   * call; an existing chat keeps its own (ADR 0120).
   */
  activeWorker(workspaceId: string, options?: { model?: string }): Promise<Agent>;
  /**
   * Creates a pipeline stage agent (R6): kind `stage`, active, with the given role, title, and model (`provider/id`).
   * It starts no process. A caller runs it in `store.transaction` together with `deliver`, so the agent starts only
   * through its delivery after the commit. Throws a 404 ApiError for an unknown workspace.
   */
  createStage(
    workspaceId: string,
    stage: { role: StageRole; title: string; model?: string },
  ): Agent;
  /** The model and thinking level a role gets from the user's pi-subagents settings (ADR 0013). */
  roleDefaults(role: string): Promise<RoleDefaults>;
  /**
   * The distinct physical models (`provider/id`) Pi recorded on the agent's assistant messages, in the order they
   * first appear. Empty when the agent has no session yet.
   */
  modelsUsed(agentId: string): Promise<string[]>;
  /** One agent (chat). Throws a 404 ApiError for an unknown id. */
  get(agentId: string): Agent;
  /** Every agent, for Home. */
  attention(): AgentAttention[];
  /**
   * Called after an agent's status, dialogs, or waiting mark change, and with `chat` after its title or active flag
   * changed (an older worker chat is not active, ADR 0030).
   */
  onChange(listener: (agentId: string, change: AgentChange) => void): void;
  /**
   * Runs before retention deletes a closed chat's row (ADR 0121), so a module drops what it holds for that agent. It
   * must be safe to run again: a throw is logged and the chat stays for the next sweep.
   */
  beforeDeleteChat(listener: (agentId: string) => void): void;
  /**
   * Runs at each launch of an agent's process, so a module can add environment variables and replace the tools. It
   * must be synchronous. The bridge token's read-only flag does not change. Throws when two hooks give `tools` for one
   * agent.
   */
  addLaunchContext(hook: LaunchHook): void;
}

export const AgentsKey = defineInterface<Agents>("agents", "agents");
