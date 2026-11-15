import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import type { WebModule } from "@pi-spore/module-api";
import { AgentGraph } from "./canvas.js";

/** The agent graph's web side: the live canvas on the workspaces landing page (ADR 0176). */
export const agentGraphWeb: WebModule = {
  id: "agent-graph",
  requires: ["workspaces"],
  core: false,
  setup(host) {
    host.use(WorkspaceViewKey).setLanding(AgentGraph);
  },
};
