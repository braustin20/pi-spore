import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type { Lane, ReviseLaneRequest, Run, StartLaneRequest } from "@pi-spore/shared";

/**
 * Runs for the bridge (R7). `startLane` and `reviseLane` answer 403 `not_coordinator` when the caller's workspace is not
 * a run workspace.
 */
export interface Runs {
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
  /** The lane whose workspace this is. */
  laneOf(workspaceId: string): { runId: string; laneId: string } | undefined;
  /** The run whose workspace this is. */
  runOf(workspaceId: string): Run | undefined;
}

export const RunsKey = defineInterface<Runs>("runs", "runs");
