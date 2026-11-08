import type { Agent, Workspace } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { needsRefresh, reduceAgentList, workspaceStatus, workspaceStatuses } from "./status.js";
import type { UserWait } from "./web-contract.js";

const workspace = (state: Workspace["state"]): Workspace => ({
  id: "w1",
  projectId: "p1",
  name: "w",
  slug: "w",
  isolation: "new",
  path: "/tmp/w",
  state,
  createdAt: 0,
  updatedAt: 0,
});
const agent = (status: Agent["status"]): Agent => ({
  id: "a1",
  workspaceId: "w1",
  role: "orchestrator",
  kind: "worker",
  active: true,
  status,
  createdAt: 0,
});

describe("agent list page state", () => {
  it("applies updates and replaces stale state on reconnect", () => {
    let state = reduceAgentList([], { type: "snapshot", agents: [agent("idle")] });
    state = reduceAgentList(state, { type: "agent", agent: agent("busy") });
    expect(workspaceStatus(workspace("active"), state[0]).text).toBe("Working");
    state = reduceAgentList(state, { type: "agent", agent: agent("idle") });
    expect(workspaceStatus(workspace("active"), state[0]).text).toBe("Idle");
    state = reduceAgentList(state, { type: "snapshot", agents: [] });
    expect(workspaceStatus(workspace("active"), state[0]).text).toBe("No agent yet");
  });
});

describe("workspaceStatus", () => {
  it("shows the agent's status for an active workspace", () => {
    expect(workspaceStatus(workspace("active"), agent("busy"))).toEqual({
      text: "Working",
      tone: "run",
    });
    expect(workspaceStatus(workspace("active"), agent("failed")).tone).toBe("fail");
    expect(workspaceStatus(workspace("active"), undefined).text).toBe("No agent yet");
  });

  it("shows parked and archived over any agent status", () => {
    expect(workspaceStatus(workspace("parked"), agent("busy")).text).toBe("Parked");
    expect(workspaceStatus(workspace("archived"), undefined).text).toBe("Archived");
  });
});

describe("workspaceStatuses", () => {
  const chat = (id: string, status: Agent["status"], extra: Partial<Agent> = {}): Agent => ({
    ...agent(status),
    id,
    ...extra,
  });
  const lines = (agents: Agent[], waits: [string, UserWait][]) =>
    workspaceStatuses([workspace("active")], agents, new Map(waits)).get("w1")!;

  it("shows that the active worker chat waits for the user, and Idle again once answered", () => {
    expect(lines([chat("a1", "idle")], [["a1", "question"]])).toEqual({
      text: "Waiting for your answer",
      tone: "warn",
    });
    expect(lines([chat("a1", "idle")], []).text).toBe("Idle");
    expect(lines([chat("a1", "stopped")], [["a1", "approval"]]).text).toBe(
      "Waiting for your answer",
    );
  });

  it("shows an idle chat with a running helper as working, but a wait for the user first", () => {
    expect(lines([chat("a1", "idle", { helpersRunning: 1 })], [])).toEqual({
      text: "Working (helper running)",
      tone: "run",
    });
    expect(lines([chat("a1", "idle", { helpersRunning: 2 })], [["a1", "question"]]).text).toBe(
      "Waiting for your answer",
    );
  });

  it("keeps a busy or failed chat's own status", () => {
    expect(lines([chat("a1", "busy")], [["a1", "dialog"]]).text).toBe("Working");
    expect(lines([chat("a1", "failed")], [["a1", "question"]]).text).toBe("Agent failed");
  });

  it("ignores a side chat's or an older chat's wait (ADR 0030)", () => {
    const agents = [
      chat("a1", "idle"),
      chat("side", "idle", { kind: "side" }),
      chat("old", "idle", { active: false }),
    ];
    expect(
      lines(agents, [
        ["side", "question"],
        ["old", "approval"],
      ]).text,
    ).toBe("Idle");
  });
});

describe("needsRefresh", () => {
  it("is true only while an agent is busy, starting, or waiting", () => {
    expect(needsRefresh([agent("idle"), agent("stopped")])).toBe(false);
    expect(needsRefresh([agent("idle"), agent("waiting")])).toBe(true);
  });
});
