import { Agent, parse, type Workspace } from "@pi-spore/shared";
import type { Tone } from "@pi-spore/ui";
import Type from "typebox";

const ListEvent = Type.Union([
  Type.Object({ type: Type.Literal("snapshot"), agents: Type.Array(Agent) }),
  Type.Object({ type: Type.Literal("agent"), agent: Agent }),
]);

export function reduceAgentList(agents: Agent[], raw: unknown): Agent[] {
  const event = parse(ListEvent, raw, "agent list event");
  if (event.type === "snapshot") return event.agents;
  return [...agents.filter((agent) => agent.id !== event.agent.id), event.agent];
}

export interface StatusText {
  text: string;
  tone: Tone;
}

const BY_STATUS: Record<Agent["status"], StatusText> = {
  busy: { text: "Working", tone: "run" },
  starting: { text: "Starting the agent", tone: "run" },
  waiting: { text: "Waiting for a free agent slot", tone: "warn" },
  idle: { text: "Idle", tone: "neutral" },
  stopped: { text: "Agent stopped", tone: "neutral" },
  failed: { text: "Agent failed", tone: "fail" },
};

/** The list column's status line for a workspace, from its worker agent if it has one. */
export function workspaceStatus(workspace: Workspace, agent: Agent | undefined): StatusText {
  if (workspace.state === "parked") return { text: "Parked", tone: "neutral" };
  if (workspace.state === "archived") return { text: "Archived", tone: "neutral" };
  if (!agent) return { text: "No agent yet", tone: "neutral" };
  return BY_STATUS[agent.status];
}

/** Whether any agent is transitioning or working. */
export function needsRefresh(agents: readonly Agent[]): boolean {
  return agents.some(
    (agent) => agent.status === "busy" || agent.status === "starting" || agent.status === "waiting",
  );
}
