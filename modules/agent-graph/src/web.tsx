import type { WebModule } from "@pi-spore/module-api";

/** The agent graph's web side. The canvas comes later (ADR 0176); the server serves the graph now. */
export const agentGraphWeb: WebModule = {
  id: "agent-graph",
  requires: [],
  core: false,
  setup() {},
};
