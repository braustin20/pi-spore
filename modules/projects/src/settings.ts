import type { Settings } from "@pi-spore/module-api";
import Type from "typebox";

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_BRANCH_PREFIX = "spore";

/** Declares the settings this module owns (R17). Other modules declare theirs in their own setup. */
export function declareSettings(settings: Settings) {
  // The router extension reads these sections of settings.json itself (architecture 10).
  settings.reserve("global", "router");
  settings.reserve("global", "tiers");
  return {
    retentionDays: settings.declare({
      key: "retention.days",
      schema: Type.Integer({ minimum: 0 }),
      default: DEFAULT_RETENTION_DAYS,
      scope: "global",
    }),
    worktreeCopy: settings.declare({
      key: "worktree.copy",
      schema: Type.Array(Type.String({ minLength: 1 })),
      default: [] as string[],
      scope: "project",
    }),
    branchPrefix: settings.declare({
      key: "worktree.branch_prefix",
      schema: Type.String({ pattern: "^[a-zA-Z0-9._-]+$" }),
      default: DEFAULT_BRANCH_PREFIX,
      scope: "project",
    }),
  };
}

export type ProjectSettings = ReturnType<typeof declareSettings>;
