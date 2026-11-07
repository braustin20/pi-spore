# 0090. Changes and pull requests: two modules on provider capabilities

- Status: Accepted
- Date: 2026-11-07
- Requirements: R8, R9, R11.4

## Context

The workspace needs a Changes tab (R8) and a PR tab (R9). ADR 0005 says VCS work goes through a provider with
neutral words and optional capabilities. A pull request is a forge feature (GitHub), not a VCS feature: a Git repo
may have no forge, or another one. Pushing is outward-facing, and pi-spore must never merge, enable auto-merge,
close a PR, or force-push (R9.3). The job runner does not exist yet, so PR watching cannot be a job. Some projects
run review bots on PRs (open question Q14).

## Decision

- The `VcsProvider` gets two optional capabilities: `changes` (scopes `uncommitted`, `staged`, `line`, `record`;
  files with counts; one file's diff; records since a base) and `publish` (push a line, never force). Git
  implements both. Folder projects have neither, and the tabs say so.
- A workspace records its base when a new branch is made. Older workspaces, existing branches, and in-place work
  fall back to the provider's default base.
- Module `changes` owns the Changes tab, the diff API, and diff-line comments. "Send to agent" delivers all open
  comments as one message to the workspace's active worker chat through `AgentsKey.deliver`, and marks them sent in
  the same transaction. Attaching comments to the composer instead (R8.3) is a later step.
- Module `github-pr` owns the PR tab and talks to GitHub only through `gh`, with argv arrays, `--json` output, and
  TypeBox checks. It runs only `gh pr view`, `gh pr create`, `gh run view --log-failed`, and read-only `gh api` GETs.
  No code path runs `gh pr merge`, `gh pr close`, or `--auto`.
- Publishing needs `confirm: true` in the request; the UI asks first. It pushes through `publish`, then opens the
  PR. The kanban card of the workspace moves to Review when the PR opens and to Done when it is merged
  (`CardsKey.workChanged`), so `github-pr` requires `kanban`.
- PR watch is a timer per watched PR, kept in the module's table, so it resumes after a restart. It polls with
  backoff (30 s doubling to 5 min, back to 30 s when something changes). When no check is pending on the PR's head
  commit and a check failed, or a review bot left new comments, it sends one message to the worker: failed checks
  with a bounded log tail, and the bot comments (Q14: fed to the worker). At most 3 such tries in a row; a head
  with every check passed and no new bot comment ends the run of tries. After 3 it stops sending and shows "waiting
  for you" until the user resumes the watch.
- A bot is an author GitHub marks as type `Bot`. Comments of people are not sent.

## Consequences

- Another forge is another module on the same `publish` capability.
- Disabling `kanban` disables `github-pr`.
- "Waiting for you" shows on the PR tab and the Details tab, not on Home: the attention module has no way for
  other modules to add items yet (Q18).
- PR watch moves to the job runner when it lands.
- A bot that comments on every push uses up the 3 tries, then waits for the user, which is the intent.
