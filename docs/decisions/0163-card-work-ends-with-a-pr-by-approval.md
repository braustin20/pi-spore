# 0163. Card work ends with a PR, opened on the user's approval

- Status: Accepted
- Date: 2026-11-09
- Requirements: R9.3, R16.3
- Extends: [ADR 0151](0151-run-cancel-handover-and-pr-approval.md)

## Context

ADR 0151 lets a run's coordinator ask the user to open the run's PR with a `run-pr` approval. Work started from a
card had no such step. The chat stopped, and the user opened the PR by hand from the PR tab, or asked the chat to
run `gh`.

## Decision

- When the work came from a card, and check and the tests pass, the orchestrator chat calls `open_pr { title, body }`.
  The tool files a `workspace-pr` approval (ADR 0100) for the chat's workspace and ends the turn. Only the
  orchestrator chat has the tool: not side chats, stage agents, run coordinators, or lanes.
- The github-pr module owns the kind. Its subject is `{ workspaceId, title, body, base }`. The base is the
  workspace's base, else the project's default branch, as the PR tab shows it.
- Before it files anything, the request refuses a workspace that cannot be published (422 `not_supported`), an open
  PR (409 `pr_exists`), and a second open request (409 `workspace_pr_asked`). Nothing is pushed then.
- On approve, the user may edit the title and body only. github-pr then pushes the branch and opens the PR through
  the same path as the PR tab's publish. Decline opens and pushes nothing.
- The bridge does not depend on github-pr. The bridge exports `BridgeKey.setPrRequester`, and github-pr sets it, the
  same way it sets `RunsKey.setPrOpener`. Without github-pr, the route answers 422 `not_supported`.
- Nothing merges the PR but a human (ADR 0130, ADR 0142).

## Consequences

- github-pr requires bridge. Turning off github-pr leaves the bridge and its tools on.
- An agent no longer needs `gh` to open a PR, and nothing reaches GitHub without the user's yes.
