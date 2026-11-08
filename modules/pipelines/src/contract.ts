import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type { PipelineRun, PipelineTurn, StageReport } from "@pi-spore/shared";

export interface StartRunRequest {
  pipeline: string;
  brief: string;
  /** The agent that asked for the run and gets its approvals. Defaults to the workspace's active worker chat. */
  askingAgentId?: string;
  /** `provider/id`. The model of the worker stage (stage 0) for this run only, instead of the stage's own. */
  workerModel?: string;
}

export interface Pipelines {
  /**
   * Starts a run as `POST /api/pipelines/workspaces/:id/runs` does, with the same errors: 409 `workspace_not_active`,
   * 409 `pipeline_running`, 404 `pipeline_not_found`, 422 `bad_pipeline`.
   */
  start(workspaceId: string, request: StartRunRequest): Promise<PipelineRun>;
  /**
   * Runs for every run that ends (passed, failed, or stopped), inside the transaction that ends it, with the run as it
   * is after the update. A throw rolls the end back.
   */
  afterRunEnded(listener: (run: PipelineRun) => void): void;
  /**
   * Records the report of a stage agent's turn and wakes the stage's job, in one transaction. Throws 404
   * `turn_not_found`; 403 `not_your_turn` when the caller is not the turn's agent; 409 `turn_closed` for a turn that is
   * not the run's latest; 409 `run_ended` when the run is not running; 400 `bad_report` when the report breaks its
   * role's rules. A repeat for the latest turn returns the stored turn.
   */
  report(caller: BridgeCaller, report: StageReport): { turn: PipelineTurn };
}

export const PipelinesKey = defineInterface<Pipelines>("pipelines", "pipelines");
