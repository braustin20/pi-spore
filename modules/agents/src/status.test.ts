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

  it("shows the router's waiting text for a busy agent", () => {
    const waiting = { ...agent("busy"), routerStatus: "Waiting for local/qwen" };
    expect(workspaceStatus(workspace("active"), waiting)).toEqual({
      text: "Waiting for local/qwen",
      tone: "warn",
    });
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

  it("shows an idle or stopped chat that works for something as working, but a wait for the user first", () => {
    const working = { workingFor: "Pipeline: gates" };
    expect(lines([chat("a1", "idle", working)], [])).toEqual({
      text: "Working (Pipeline: gates)",
      tone: "run",
    });
    expect(lines([chat("a1", "stopped", working)], []).text).toBe("Working (Pipeline: gates)");
    expect(lines([chat("a1", "idle", working)], [["a1", "question"]]).text).toBe(
      "Waiting for your answer",
    );
    expect(lines([chat("a1", "failed", working)], []).text).toBe("Agent failed");
  });

  it("shows a busy stage agent over a worker chat that works for something", () => {
    const worker = chat("a1", "stopped", { workingFor: "Pipeline: gates" });
    const stage = chat("s1", "busy", { kind: "stage", title: "Implement" });
    expect(lines([worker, stage], []).text).toBe("Working: Implement");
  });

  it("keeps a busy or failed chat's own status", () => {
    expect(lines([chat("a1", "busy")], [["a1", "dialog"]]).text).toBe("Working");
    expect(lines([chat("a1", "failed")], [["a1", "question"]]).text).toBe("Agent failed");
  });

  it("shows a working stage agent's title over a stopped or missing worker chat", () => {
    const stage = (id: string, status: Agent["status"], title?: string) =>
      chat(id, status, { kind: "stage", role: "reviewer", ...(title ? { title } : {}) });
    expect(lines([chat("a1", "stopped"), stage("s1", "busy", "review round 1")], [])).toEqual({
      text: "Working: review round 1",
      tone: "run",
    });
    expect(lines([stage("s1", "starting")], []).tone).toBe("run");
    expect(lines([stage("s1", "waiting", "review round 1")], [])).toEqual({
      text: "Waiting for a free agent slot",
      tone: "warn",
    });
    expect(
      lines([stage("s0", "waiting"), stage("s1", "busy", "Implement")], [["a1", "question"]]).text,
    ).toBe("Working: Implement");
  });

  it("follows the worker chat when no stage agent works", () => {
    const stage = (status: Agent["status"]) => chat("s1", status, { kind: "stage", title: "x" });
    expect(lines([chat("a1", "stopped"), stage("idle")], []).text).toBe("Agent stopped");
    expect(lines([chat("a1", "idle"), stage("stopped")], [["a1", "question"]]).text).toBe(
      "Waiting for your answer",
    );
    expect(lines([stage("failed")], []).text).toBe("No agent yet");
  });

  it("keeps each workspace's stage agents to itself", () => {
    const other = { ...workspace("active"), id: "w2" };
    const statuses = workspaceStatuses(
      [workspace("active"), other],
      [
        chat("a1", "stopped"),
        chat("s2", "busy", { kind: "stage", workspaceId: "w2", title: "Implement" }),
      ],
      new Map(),
    );
    expect(statuses.get("w1")?.text).toBe("Agent stopped");
    expect(statuses.get("w2")?.text).toBe("Working: Implement");
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
