# 0166. A workspace or run gets its settings override when it is made

- Status: Accepted
- Date: 2026-11-09
- Requirements: R17.1, R17.2, R17.3

## Context

R17.2 ends the resolve order with a run or workspace override, but no store held one. Only two settings can differ
per project, `worktree.copy` and `worktree.branch_prefix`, and only workspace creation reads them. So an override
does something only if it is known when the workspace is made.

Two options were weighed: a core table keyed by workspace or run id that can be set at any time, or an override
given at creation and stored by the module that owns the workspace or run. On 2026-11-09 the user chose the second.

## Decision

- The resolver takes the override as an argument, like detected values, and applies it last:
  `resolve({ override: { source: "workspace" | "run", values } })`. Core has no override table.
- `values` is a nested table, the same form as the files. It sets only declared `project` keys, never a reserved
  section, and never a model key (R17.3). A bad one answers 422 `bad_override`.
- `POST /api/workspaces` takes `settings`. The workspaces module stores it in its own table, with source
  `workspace`. `POST /api/runs` takes `settings`. The runs module stores it and passes it to the run workspace and
  every lane workspace, with source `run`.
- Nothing changes an override after creation, because nothing reads project settings after a workspace is made.
- `GET /api/workspaces/:id/settings` and the Settings page show each value with its source.

## Consequences

- Modules keep their own tables; core knows nothing of workspaces or runs.
- If a later setting is read after creation, a way to change an override is a new decision.
