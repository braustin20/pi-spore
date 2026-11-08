import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type { PipelineTurn, StageReport } from "@pi-spore/shared";

export interface Pipelines {
  /**
   * Records the report of a stage agent's turn and wakes the stage's job, in one transaction. A worker turn also keeps
   * the router's newest decision for its agent (R4.7). Throws 404
   * `turn_not_found`; 403 `not_your_turn` when the caller is not the turn's agent; 409 `turn_closed` for a turn that is
   * not the run's latest; 409 `run_ended` when the run is not running; 400 `bad_report` when the report breaks its
   * role's rules. A repeat for the latest turn returns the stored turn.
   */
  report(caller: BridgeCaller, report: StageReport): Promise<{ turn: PipelineTurn }>;
}

export const PipelinesKey = defineInterface<Pipelines>("pipelines", "pipelines");
