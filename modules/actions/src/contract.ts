import { defineInterface } from "@pi-spore/module-api";
import type { ActionRun, ActionTrigger, ActionView } from "@pi-spore/shared";

/** Project actions for other modules, such as pipeline gates and spore-bridge's `run_action` later. */
export interface Actions {
  list(workspaceId: string): Promise<ActionView[]>;
  /** Starts a run. Throws ApiError 404 for an unknown action. Exclusive runs may start queued. */
  start(workspaceId: string, name: string, trigger: ActionTrigger): Promise<ActionRun>;
  /** Resolves when the run has ended. */
  wait(runId: string): Promise<ActionRun>;
}

export const ActionsKey = defineInterface<Actions>("actions", "actions");
