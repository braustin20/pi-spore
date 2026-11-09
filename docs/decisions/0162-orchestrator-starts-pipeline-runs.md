# 0162. The orchestrator sends each slice through the workspace's pipeline

- Status: Accepted
- Date: 2026-11-09
- Requirements: R4.2, R4.9, R6, R16.3
- Amends: [ADR 0120](0120-orchestrator-chat-and-card-models.md)

## Context

- ADR 0120 has the orchestrator chat start `worker` subagents for the feature code. A subagent is a child of the
  chat, not a pipeline run. So workspace work gets no review stages, no round limits, no tier checks, and no
  outcome for the router's calibration (ADR 0144).
- `router.explore` fires only for a pipeline worker stage (`PI_SPORE_STAGE_ROLE=worker`), so it never fires for
  workspace work.
- A coordinator already starts pipeline runs through lanes (`start_lane`). A workspace chat has no such tool.
- The pipelines route `POST /api/pipelines/workspaces/:id/runs` takes the user token only. Agent tokens are valid
  only on bridge routes (architecture section 2).
- A run that is not a lane ends without telling its chat. Only the runs module listens to `afterRunEnded`, and only
  for lanes.

## Decision

1. **The pipeline's worker stage writes each slice.** The orchestrator no longer starts `worker` subagents for
   feature code. One slice is one pipeline run. `scout`, `researcher`, and `reviewer` subagents stay as they are.
2. **The plan's yes covers its runs.** The user's yes to the plan also covers the pipeline runs of that plan. The
   plan names the slices and says each one runs through the workspace pipeline.
3. **The conciseness check stays.** After a run passes, the orchestrator reads the diff. Cuts go in as a new
   pipeline run with the cuts as its brief. After three runs without success, it splits the slice again or takes
   it over.
4. **Which pipeline.** `default`, unless the brief's tool call names another pipeline of the workspace.
5. **Tool.** spore-bridge gives the orchestrator chat (a `worker`-kind chat with no run role) the tool
   `start_pipeline { brief, pipeline? }`. `brief` is a workspace artifact path, as for `start_lane`. The tool posts
   to the bridge route `POST /api/bridge/pipelines` with the tool call id as its receipt (R16.3), so a replayed
   call gets the first answer and starts no second run. The bridge route reads the brief artifact (404
   `brief_not_found`) and calls `PipelinesKey.start` with the calling agent as the asking chat. It is a bridge
   route, not the user route, because agent tokens work only on bridge routes. Side chats are refused.
6. **End message.** When a run that is not a lane ends (`passed`, `failed`, or `stopped`), its asking chat gets one
   message in the transaction that ends it: the run, the state, the failure or stop text, and the last review's
   verdict and findings. A lane run gets none from pipelines; the runs module tells its coordinator.
7. **Limits stay.** One run per workspace at a time (409 `pipeline_running`) keeps one writer in the worktree. The
   tool pins no model: the worker stage runs on `spore/auto` when it says `tier = "route"`. The tool never merges
   and never changes a model or a setting.

## Consequences

- Workspace work gets review rounds, the reviewer tier check, fail-first proof, and gates.
- Every slice gives one calibration outcome, and `router.explore` can send workspace slices local.
- The orchestrator waits for the end message. It does not poll.
- A slice costs more than a subagent: at least one reviewer turn and the gates.
- A run that the user starts from the Pipeline tab also tells the workspace's chat when it ends.
