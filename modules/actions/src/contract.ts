import { defineInterface } from "@pi-spore/module-api";
import type { ActionLog, ActionRun, ActionTrigger, ActionView, Workspace } from "@pi-spore/shared";

/**
 * An action a module adds for projects with a trait, such as the Unity test gates (ADR 0156). It runs like a project
 * action (a process, a log, cancel, exclusive per folder), but the module decides when it may start and what it
 * runs. A project action of the same name replaces it.
 */
export interface ProvidedAction {
  name: string;
  description: string;
  /** Only projects with this trait list and run it. */
  trait: string;
  /**
   * Runs when the run starts, before any process: waits for what the command needs, then names the command. A throw
   * fails the run with its message. `signal` aborts when the run is cancelled; then the result is ignored.
   * `timeoutMs` stops the process (SIGTERM, then SIGKILL) if it has not exited by then, and fails the run.
   * `after` runs once the process has exited, with its exit code and whether the run was cancelled or timed out
   * (`stopped`), so it can clean up without collecting results. A throw fails the run even after exit code 0.
   */
  prepare(context: {
    workspace: Workspace;
    runId: string;
    /** Appends to the run's log. */
    log(text: string): void;
    signal: AbortSignal;
  }): Promise<{
    argv: string[];
    timeoutMs?: number;
    after?(exitCode: number | null, stopped: boolean): Promise<void>;
  }>;
}

/** Project actions for other modules, such as pipeline gates and the bridge's `check` and `run_action`. */
export interface Actions {
  list(workspaceId: string): Promise<ActionView[]>;
  /** Adds an action for projects with the trait. Throws when the name is taken. */
  provide(action: ProvidedAction): void;
  /** The workspace's newest runs first, up to `limit` (default 50). With `actions`, only runs of those actions count. */
  runs(workspaceId: string, options?: { actions?: string[]; limit?: number }): ActionRun[];
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
