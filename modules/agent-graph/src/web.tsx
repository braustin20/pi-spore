import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import type { WebModule } from "@pi-spore/module-api";
import { SporeLogo } from "@pi-spore/ui";
import { AgentGraph } from "./canvas.js";

/** The agent graph's web side: the live canvas on the workspaces landing page (ADR 0176). */
export const agentGraphWeb: WebModule = {
  id: "agent-graph",
  requires: ["workspaces"],
  core: false,
  setup(host) {
    host.use(WorkspaceViewKey).setLanding(AgentGraph, { label: "Agent graph", icon: SporeLogo });
  },
};
