import type { Agent, Workspace } from "@pi-spore/shared";
import { describe, expect, it } from "vitest";
import { needsRefresh, workspaceStatus } from "./status.js";

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
  role: "worker",
  status,
  createdAt: 0,
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

describe("needsRefresh", () => {
  it("is true only while an agent is busy, starting, or waiting", () => {
    expect(needsRefresh([agent("idle"), agent("stopped")])).toBe(false);
    expect(needsRefresh([agent("idle"), agent("waiting")])).toBe(true);
  });
});
