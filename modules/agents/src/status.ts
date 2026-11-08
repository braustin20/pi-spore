import { Agent, parse, type Workspace } from "@pi-spore/shared";
import type { Tone } from "@pi-spore/ui";
import Type from "typebox";
import type { UserWait } from "./web-contract.js";

const ListEvent = Type.Union([
  Type.Object({ type: Type.Literal("snapshot"), agents: Type.Array(Agent) }),
  Type.Object({ type: Type.Literal("agent"), agent: Agent }),
  Type.Object({ type: Type.Literal("removed"), id: Type.String() }),
]);

export function reduceAgentList(agents: Agent[], raw: unknown): Agent[] {
  const event = parse(ListEvent, raw, "agent list event");
  if (event.type === "snapshot") return event.agents;
  if (event.type === "removed") return agents.filter((agent) => agent.id !== event.id);
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

/**
 * The list column's status line for a workspace, from its worker agent if it has one. A chat that waits for the
 * user says so once it is idle or stopped.
 */
export function workspaceStatus(
  workspace: Workspace,
  agent: Agent | undefined,
  wait?: UserWait,
): StatusText {
  if (workspace.state === "parked") return { text: "Parked", tone: "neutral" };
  if (workspace.state === "archived") return { text: "Archived", tone: "neutral" };
  if (!agent) return { text: "No agent yet", tone: "neutral" };
  if (wait && (agent.status === "idle" || agent.status === "stopped")) {
    return { text: "Waiting for your answer", tone: "warn" };
  }
  if (agent.status === "idle" && agent.helpersRunning) {
    return { text: "Working (helper running)", tone: "run" };
  }
  return BY_STATUS[agent.status];
}

/** Status lines for all workspaces. They follow the active worker chat (ADR 0030). */
export function workspaceStatuses(
  workspaces: readonly Workspace[],
  agents: readonly Agent[],
  waits: ReadonlyMap<string, UserWait>,
): Map<string, StatusText> {
  const workers = new Map(
    agents
      .filter((agent) => agent.kind === "worker" && agent.active)
      .map((agent) => [agent.workspaceId, agent]),
  );
  return new Map(
    workspaces.map((workspace) => {
      const worker = workers.get(workspace.id);
      return [workspace.id, workspaceStatus(workspace, worker, worker && waits.get(worker.id))];
    }),
  );
}

/** Whether any agent is transitioning or working. */
export function needsRefresh(agents: readonly Agent[]): boolean {
  return agents.some(
    (agent) => agent.status === "busy" || agent.status === "starting" || agent.status === "waiting",
  );
}
