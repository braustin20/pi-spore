import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type {
  AnswerLaneRequest,
  AskCoordinatorRequest,
  CreateRunRequest,
  Lane,
  MergeLaneRequest,
  ReviseLaneRequest,
  Run,
  RunQuestion,
  StartLaneRequest,
} from "@pi-spore/shared";

/**
 * Runs for the bridge (R7). `startLane`, `reviseLane`, and `mergeLane` answer 403 `not_coordinator` when the caller's workspace is not
 * a run workspace.
 */
export interface Runs {
  /** Creates a run, the same as POST /api/runs. The model is the coordinator chat's. */
  create(request: CreateRunRequest, options?: { model?: string }): Promise<Run>;
  /**
   * Adds a lane to the caller's run. 404 when the brief artifact does not exist; 400 when a `dependsOn` id is not a
   * lane of the run. A model above the worker role default's tier files a `lane-model` approval and the lane waits in
   * `approval` (R4.8); any other lane is `waiting` and its job starts.
   */
  startLane(caller: BridgeCaller, request: StartLaneRequest): Promise<Lane>;
  /**
   * Sends a `passed` or `failed` lane of the caller's run back with a new brief and starts a new pipeline run in its
   * workspace. 409 `lane_not_revisable` for a lane in another state.
   */
  reviseLane(caller: BridgeCaller, request: ReviseLaneRequest): Promise<Lane>;
  /**
   * Merges a `passed` lane of the caller's run into the run line, but commits the merge only when the run's gates
   * pass on the merged tree (ADR 0150). The lane is `merging` until then, and `merged` after. A conflict or a failed
   * gate puts it back to `passed` and tells the coordinator. 404 `lane_not_found` for a lane outside the run; 409
   * `lane_not_mergeable` for a lane that is not `passed`.
   */
  mergeLane(caller: BridgeCaller, request: MergeLaneRequest): Promise<Lane>;
  /**
   * Files a question of the caller's lane for its run's coordinator and delivers it to the coordinator chat in the
   * same transaction (R7.5, ADR 0008). 403 `not_in_lane` when the caller's workspace is not a lane.
   */
  askCoordinator(caller: BridgeCaller, request: AskCoordinatorRequest): RunQuestion;
  /**
   * Stores the coordinator's answer and delivers it to the asking lane agent in the same transaction. 403
   * `not_coordinator` for a caller outside the run workspace; 404 `question_not_found` for a question outside the
   * run; 409 `question_answered` for a second answer.
   */
  answerLane(caller: BridgeCaller, request: AnswerLaneRequest): RunQuestion;
  /** The lane whose workspace this is. */
  laneOf(workspaceId: string): { runId: string; laneId: string } | undefined;
  /** The run whose workspace this is. */
  runOf(workspaceId: string): Run | undefined;
}

export const RunsKey = defineInterface<Runs>("runs", "runs");
