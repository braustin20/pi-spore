# 0195. Uncommitted work never passes a pipeline, and an empty lane is not merged

- Status: Accepted; touches [0169](0169-remind-a-stage-agent-once-then-block.md),
  [0150](0150-run-worktree-and-green-merges.md), and [0158](0158-revise-lane-is-a-fix-pass.md)
- Renumbered from 0186 on 2026-11-23; old commits cite the old number.
- Date: 2026-11-16
- Requirements: R6, R7.4

## Context

In the paint-crafter run "Run: day/night cycle plan", lane "Day/night 8: save and load time" passed its pipeline and
merged, but the merge brought no code. The worker never committed. The reviewers' diff holds the uncommitted and
untracked files, and the gates run in the working folder, so both passed. The merge joins the lane's branch, which had
nothing new, and `finish` skips the commit of an empty merge, so the lane showed `merged` in silence.

## Decision

- The worker rules say: commit before every `report`.
- A worker report (task or fix) is checked for uncommitted, staged, and untracked files through `ChangeOps`
  (ADR 0005); gitignored files do not count. The first such report of a turn is refused with 409
  `uncommitted_changes` and the paths. That is the one reminder of the turn, in the shape of ADR 0169. It is kept on
  the turn (`commit_reminded`) across a restart.
- The `decide` step checks the workspace every time it runs. Uncommitted files block the stage with
  `uncommitted changes in <workspace>: <n> files (<first paths>). Commit them, then Retry.` This covers a second
  dirty report, files a gate left behind, and the end of the run. The run blocks and does not fail, so no work is lost:
  a commit and Retry let it go on. A revise (ADR 0158) runs the same steps.
- The merge job's `merge` step refuses a lane whose line adds nothing to the run line. The lane goes back to `passed`
  with `empty lane: its branch adds no commits`, and the coordinator is told, as for a conflict (ADR 0150). `finish`
  keeps skipping an empty commit: it runs only after `merge`, so an empty diff there means a restart already
  committed.

## Consequences

- A worker that forgets to commit costs one refused report, not lost work.
- A gate that writes files that are not gitignored now blocks runs. The project fixes its `.gitignore`.
- A project without version control that shows changes is not checked.
- `open_pr` of a plain workspace is not checked here; a workspace whose pipeline passed has committed its work.
