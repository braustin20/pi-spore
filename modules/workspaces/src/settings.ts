import type { Settings } from "@pi-spore/module-api";
import Type from "typebox";

/** Declares the settings this module owns (R17). A workspace's own `archiveOnMerge` beats this one. */
export function declareWorkspaceSettings(settings: Settings) {
  return {
    archiveOnMerge: settings.declare({
      key: "workspaces.archiveOnMerge",
      schema: Type.Boolean(),
      default: true,
      scope: "global",
    }),
  };
}
