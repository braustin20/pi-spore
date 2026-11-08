import type { WebModule } from "@pi-spore/module-api";

/** The runs UI comes later; the module has no pages yet. */
export const runsWeb: WebModule = {
  id: "runs",
  requires: [],
  core: false,
  setup() {},
};
