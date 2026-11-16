import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import type { WebModule } from "@pi-spore/module-api";
import { SporeLogo } from "@pi-spore/ui";
import { AgentGraph } from "./canvas.js";

/** The agent graph's web side: the live canvas on the workspaces landing page (ADR 0176). */
export const agentGraphWeb: WebModule = {
  id: "agent-graph",
  requires: ["workspaces", "agents"],
  core: false,
  setup(host) {
    const { useUserWaits } = host.use(AgentsWebKey);
    const Landing = ({ projectId }: { projectId?: string | undefined }) => (
      <AgentGraph projectId={projectId} useUserWaits={useUserWaits} />
    );
    host.use(WorkspaceViewKey).setLanding(Landing, { label: "Agent graph", icon: SporeLogo });
  },
};
