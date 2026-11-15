import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type {
  AnswerStageRequest,
  AskStageRequest,
  PipelineRun,
  PipelineTurn,
  StageQuestion,
  StageReport,
} from "@pi-spore/shared";

export interface StartRunRequest {
  pipeline: string;
  brief: string;
  /** The slice's name, a label only. */
  name?: string;
  /** The agent that asked for the run and gets its approvals. Defaults to the workspace's active worker chat. */
  askingAgentId?: string;
  /** `provider/id`. The model of the worker stage (stage 0) for this run only, instead of the stage's own. */
  workerModel?: string;
  /**
   * A run of the same workspace that this run continues. A pipeline whose worker stage has `worker = "reuse"` needs
   * it and reuses that run's worker agent; other pipelines refuse it.
   */
  previousRunId?: string;
}

export interface Pipelines {
  /**
   * Starts a run as `POST /api/pipelines/workspaces/:id/runs` does, with the same errors: 409 `workspace_not_active`,
   * 409 `pipeline_running`, 404 `pipeline_not_found`, 422 `bad_pipeline`.
   */
  start(workspaceId: string, request: StartRunRequest): Promise<PipelineRun>;
  /**
   * Refuses a model (`provider/id`) Pi cannot run: 400 `unknown_model`, naming the model and any model Pi has with
   * the same id under another provider. `spore/auto` always passes. Pi's 502 `models_unavailable` goes up as it is.
   * `callerAgentId` is the agent that waits on the answer; see `Agents.availableModels`.
   */
  requireModel(model: string, callerAgentId?: string): Promise<void>;
  /** The run as `GET /api/pipelines/runs/:id` returns it. Throws 404 `run_not_found`. */
  get(runId: string): PipelineRun;
  /** The workspace's runs, newest first, as `GET /api/pipelines/workspaces/:id/runs` returns them. */
  runsOf(workspaceId: string): PipelineRun[];
  /**
   * Runs for every run that ends (passed, failed, or stopped), inside the transaction that ends it, with the run as it
   * is after the update. A throw rolls the end back.
   */
  afterRunEnded(listener: (run: PipelineRun) => void): void;
  /**
   * Runs whenever a workspace's runs change as the browser sees them, `blocked` included. It may run inside a
   * transaction.
   */
  onChange(listener: (workspaceId: string) => void): void;
  /**
   * Ends a `running` or `waiting_user` run as `stopped` with the message and cancels its stage jobs, as
   * `POST /api/pipelines/runs/:id/cancel` does. It joins the caller's `store.transaction`. Throws 404 `run_not_found`;
   * 409 `run_ended` when the run has ended.
   */
  stop(runId: string, message: string): void;
  /**
   * Records the report of a stage agent's turn and wakes the stage's job, in one transaction. A worker turn also keeps
   * the router's newest decision for its agent (R4.7). Throws 404
   * `turn_not_found`; 403 `not_your_turn` when the caller is not the turn's agent; 409 `turn_closed` for a turn that is
   * not the run's latest; 409 `run_ended` when the run is not running; 400 `bad_report` when the report breaks its
   * role's rules. A repeat for the latest turn returns the stored turn.
   */
  report(caller: BridgeCaller, report: StageReport): Promise<{ turn: PipelineTurn }>;
  /**
   * A stage agent outside a lane asks the chat that started its run (ADR 0179), and the pipeline's `await` step waits
   * for the answer. Read-only callers may ask. Throws 403 `not_a_stage` when the caller is not a stage agent; 403
   * `in_lane` for a stage agent of a lane (it asks with `ask_coordinator`); 409 `turn_closed` when the caller is not the
   * agent of its run's open turn. The question goes to the run's asking chat, or to the workspace's active worker chat
   * when the asking chat is closed; that chat then becomes the run's asking chat.
   */
  askStage(caller: BridgeCaller, request: AskStageRequest): Promise<StageQuestion>;
  /**
   * The asked chat answers a stage question, and the answer goes to the stage agent. Throws 404 `question_not_found`;
   * 403 `not_asked` when the caller is not the chat that was asked; 409 `question_answered`; 409 `turn_closed` when the
   * question's turn is no longer the run's open turn.
   */
  answerStage(caller: BridgeCaller, request: AnswerStageRequest): StageQuestion;
  /**
   * Marks the chat of each running run as working again. The runs module calls it after a run's coordinator changed,
   * because a lane's run belongs to its coordinator and nothing in the pipelines module changed.
   */
  refreshWorking(): void;
  /**
   * Sets how a run's approvals name a lane workspace, and which chat hears that a lane's run is blocked. The runs
   * module sets it, because runs requires pipelines. At most one.
   */
  setLaneLookup(
    lookup: (
      workspaceId: string,
    ) => { run: string; laneId: string; lane: string; coordinatorAgentId: string } | undefined,
  ): void;
}

export const PipelinesKey = defineInterface<Pipelines>("pipelines", "pipelines");
