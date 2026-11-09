# 0142. pi-spore merges a PR only when the user clicks Merge and confirms

- Status: Accepted; superseded in part by [0164](0164-merge-when-checks-pass.md), where the PR watch merges a
  PR whose approval said "Open and merge when checks pass"
- Date: 2026-11-08
- Requirements: R9.3

## Context

- ADR 0090 and ADR 0130 say pi-spore's own code never merges. An agent merges only on the user's word.
- The user merges PRs on GitHub by hand, or asks a chat to do it. They want a Merge button in the PR tab.
- A click the user confirms is the user's own act. It carries no risk of a merge the user did not want. But the
  code that runs it is pi-spore's own, so the old rule does not hold as written.

## Decision

- pi-spore merges a PR in one case only: the user clicks Merge in the PR tab and confirms. The confirm names the PR
  number, the base branch, and the method.
- The route `POST /api/github-pr/workspaces/:id/merge` takes only the user's token. Agent tokens reach only bridge
  routes (ADR 0032), so an agent cannot press the button. No bridge route merges.
- The route reads the PR fresh and refuses a PR that is not open, is a draft, is not known to be free of conflicts,
  has a check that failed, was cancelled, or still runs, or waits for a review. It names the reason. There is no
  override.
- It runs `gh pr merge <n> --merge --match-head-commit <sha>`, with the head the user saw. A push after the user
  looked makes GitHub refuse, and nothing merges. Never `--admin`, `--auto`, or `--delete-branch`: the branch stays.
- Nothing else changes. No auto-merge. No merge after checks pass. The PR watch never merges. ADR 0130 still governs
  agents.

## Consequences

- The user finishes a card from the PR tab. The merged state moves the card to Done (ADR 0040); the route does not
  move it.
- `AGENTS.md`, R9.3, and the chat rules name this case.
- The tests fail on any gh merge call with other flags.
