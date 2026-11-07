import { defineInterface } from "@pi-spore/module-api";
import type { Agent, AgentDialog } from "@pi-spore/shared";

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

export interface Agents {
  /**
   * Queues a message for the agent as a durable delivery (architecture 6): a prompt when it is idle, a follow-up when
   * it is busy, a start first when it is stopped. A parked workspace keeps it until it is resumed. The row is written
   * at once, so a caller inside `store.transaction` commits it together with its own changes.
   */
  deliver(agentId: string, message: string): void;
  /** Every agent, for Home. */
  attention(): AgentAttention[];
  /** Called after an agent's status, dialogs, or waiting mark change. */
  onChange(listener: () => void): void;
}

export const AgentsKey = defineInterface<Agents>("agents", "agents");
