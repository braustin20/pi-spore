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

const WorkingEvent = Type.Object({
  type: Type.Literal("working"),
  /** Every workspace that works for something, by workspace id. */
  workspaces: Type.Record(Type.String(), Type.String()),
});

/**
 * The workspace working labels from an `agents:working` event. Every event carries the whole map, so a reconnecting
 * page only needs the last one.
 */
export function parseWorkspaceWorking(raw: unknown): ReadonlyMap<string, string> {
  const event = parse(WorkingEvent, raw, "workspace working event");
  return new Map(Object.entries(event.workspaces));
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
 * Whether a chat's wait for the user shows, on the workspace list and the agent graph. A dialog blocks the chat
 * mid-turn, so it shows also while the chat is busy. A question or approval shows once the chat is idle or stopped; a
 * busy chat with an old one still works.
 */
export function waitShows(status: Agent["status"], wait: UserWait | undefined): boolean {
  if (wait === "dialog") return status !== "failed";
  return wait !== undefined && (status === "idle" || status === "stopped");
}

/**
 * The list column's status line for a workspace, from its worker agent if it has one. A chat that waits for the user
 * says so when `waitShows`. `workspaceLabel` is what the workspace itself works for, such as a running
 * pipeline run: it shows as working where the chat would only read Idle, Agent stopped, or No agent yet, and a busy
 * chat, a helper, a wait for the user, or the chat's own label all beat it.
 */
export function workspaceStatus(
  workspace: Workspace,
  agent: Agent | undefined,
  wait?: UserWait,
  workspaceLabel?: string,
): StatusText {
  if (workspace.state === "parked") return { text: "Parked", tone: "neutral" };
  if (workspace.state === "archived") return { text: "Archived", tone: "neutral" };
  if (!agent)
    return workspaceLabel
      ? { text: `Working (${workspaceLabel})`, tone: "run" }
      : { text: "No agent yet", tone: "neutral" };
  if (waitShows(agent.status, wait)) {
    return { text: "Waiting for your answer", tone: "warn" };
  }
  if (agent.status === "idle" && agent.helpersRunning) {
    return { text: "Working (helper running)", tone: "run" };
  }
  const workingFor = agent.workingFor ?? workspaceLabel;
  if ((agent.status === "idle" || agent.status === "stopped") && workingFor) {
    return { text: `Working (${workingFor})`, tone: "run" };
  }
  if (agent.status === "busy" && agent.routerStatus) {
    return { text: agent.routerStatus, tone: "warn" };
  }
  return BY_STATUS[agent.status];
}

const isLive = (agent: Agent) =>
  agent.status === "busy" || agent.status === "starting" || agent.status === "waiting";

/** A pipeline stage agent's work, named by its title, which carries the stage and round. */
function stageStatus(workspace: Workspace, stage: Agent): StatusText {
  const status = workspaceStatus(workspace, stage);
  if (stage.status === "waiting" || stage.routerStatus || !stage.title) return status;
  return { text: `${status.text}: ${stage.title}`, tone: status.tone };
}

/**
 * Status lines for all workspaces. A busy, starting, or waiting stage agent wins, since in a pipeline or a run lane
 * the worker chat sits stopped while stages work. Otherwise the line follows the active worker chat (ADR 0030), and
 * the workspace's own label, such as a running pipeline run, shows where that chat is only idle or stopped (R7).
 */
export function workspaceStatuses(
  workspaces: readonly Workspace[],
  agents: readonly Agent[],
  waits: ReadonlyMap<string, UserWait>,
  working: ReadonlyMap<string, string>,
): Map<string, StatusText> {
  const workers = new Map(
    agents
      .filter((agent) => agent.kind === "worker" && agent.active)
      .map((agent) => [agent.workspaceId, agent]),
  );
  // A stage that works beats one that waits for a slot.
  const stages = new Map<string, Agent>();
  for (const agent of agents) {
    if (agent.kind !== "stage" || !isLive(agent)) continue;
    const current = stages.get(agent.workspaceId);
    if (!current || current.status === "waiting") stages.set(agent.workspaceId, agent);
  }
  return new Map(
    workspaces.map((workspace) => {
      const stage = stages.get(workspace.id);
      if (stage && workspace.state === "active")
        return [workspace.id, stageStatus(workspace, stage)];
      const worker = workers.get(workspace.id);
      return [
        workspace.id,
        workspaceStatus(
          workspace,
          worker,
          worker && waits.get(worker.id),
          working.get(workspace.id),
        ),
      ];
    }),
  );
}

/** Whether any agent is transitioning or working. */
export function needsRefresh(agents: readonly Agent[]): boolean {
  return agents.some(isLive);
}
