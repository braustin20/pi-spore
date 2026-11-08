import { defineInterface } from "@pi-spore/module-api";
import type { ActionLog, ActionRun, ActionTrigger, ActionView } from "@pi-spore/shared";

/** Project actions for other modules, such as pipeline gates and the bridge's `check` and `run_action`. */
export interface Actions {
  list(workspaceId: string): Promise<ActionView[]>;
  /**
   * Starts a run. Throws ApiError 404 for an unknown action. Exclusive runs may start queued. With a `key` that
   * this workspace already used, starts nothing and returns the run stored under it, whatever its status. A caller
   * stores the key before it waits, so a restart never runs the same check twice.
   */
  start(
    workspaceId: string,
    name: string,
    trigger: ActionTrigger,
    options?: { key?: string },
  ): Promise<ActionRun>;
  /** Resolves when the run has ended. */
  wait(runId: string): Promise<ActionRun>;
  /** Throws ApiError 404 for an unknown run. */
  get(runId: string): ActionRun;
  /** The log from byte `from`, or its tail; with `waitMs`, waits for new output or the end first. */
  readLog(runId: string, from: number | undefined, waitMs?: number): Promise<ActionLog>;
  cancel(runId: string): ActionRun;
}

export const ActionsKey = defineInterface<Actions>("actions", "actions");
