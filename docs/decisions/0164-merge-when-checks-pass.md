# 0164. "Open and merge when checks pass" on the workspace PR approval

- Status: Accepted
- Date: 2026-11-09
- Requirements: R9.2, R9.3
- Supersedes in part: [ADR 0142](0142-merge-button.md) ("No merge after checks pass. The PR watch never merges.")
- Extends: [ADR 0163](0163-card-work-ends-with-a-pr-by-approval.md)

## Context

- ADR 0163 ends card work with a `workspace-pr` approval. The user approves, pi-spore opens the PR, and the user
  merges it later with the Merge button (ADR 0142).
- The user often waits for the checks only to press Merge. They asked on 2026-11-09 for one choice that opens the
  PR and merges it when it is ready.
- ADR 0142 says the PR watch never merges. The risk it guards against is a merge the user did not want. A choice
  the user makes for one PR, on that PR's approval, is the user's yes for that merge (ADR 0130).

## Decision

- The `workspace-pr` approval on Home has three choices: "Open PR", "Open and merge when checks pass", and Decline.
  The second sets `mergeWhenReady` on the approved subject. The chat cannot set it: the subject the chat files has
  it off, and only the user's token reaches approve.
- The choice is the user's yes for that one PR. It does not carry over to another PR, a reopened PR, or another
  workspace. The github-pr module stores it on the PR's row (`merge_when_ready`).
- For a PR with the choice on, the PR watch merges when the Merge route's readiness check (`mergeBlocked`) finds
  nothing: the workspace is active, the PR is open, not a draft, free of conflicts, every check passed, and no
  review waits. It runs the Merge button's command, `gh pr merge <n> --merge --match-head-commit <sha>`, with the
  head the watch just read. A newer push makes GitHub refuse, and the watch looks again.
- pi-spore never turns on GitHub's auto-merge (`--auto`), and never merges with `--admin` or `--delete-branch`.
- Failed checks and bot comments go to the orchestrator chat as before (R9.2). With the choice on, conflicts with
  the base also go to it, once for each head commit: merge the base in, fix, check, test, push, no force push.
- These messages share the watch's run of 3 tries. When the run ends without a merge, the watch turns the choice
  off, waits for the user, and its Home item names the PR and the reason.
- The PR tab shows "Will merge when checks pass" and a button that turns it off, with no confirm. Stopping the
  watch also turns it off. Nothing turns it on but the approval.
- The orchestrator chat gets `push_line`, a bridge tool that pushes its workspace's branch with the VCS `publish`
  push, which never force-pushes. It cannot merge: no bridge route merges (ADR 0032).

## Consequences

- A card can go from the chat's `open_pr` to Done with one click from the user.
- Only the github-pr module merges, in two places: the Merge route and the watch. Both use one readiness check and
  one gh command. The tests fail on any other merge form.
- `AGENTS.md`, R9.3, ADR 0142's status, and the chat rules name this case.
