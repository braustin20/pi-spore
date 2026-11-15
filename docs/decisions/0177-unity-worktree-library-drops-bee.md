# 0177. A Unity worktree gets a copied Library without `Library/Bee`

- Status: Accepted
- Date: 2026-11-14
- Requirements: R2.6, R10.2, R10.6
- Changes how [ADR 0018](0018-worktree-copy-list.md) applies to Unity. Builds on [ADR 0011](0011-unity-support.md),
  [ADR 0150](0150-run-worktree-and-green-merges.md), [ADR 0156](0156-unity-test-gates.md).

## Context

In paint-crafter (Unity 6000.6.3f1), PlayMode gates failed in lane worktrees and in the run's merge checkout:
`MonoScript.GetClass()` was null for every script of two assemblies, with about 4021
`The referenced script (Unknown) on this Behaviour is missing!` lines. The spike
(`spikes/unity-library-cache.md`, card "Unity Library 1") found the cause: the copied `Library/Bee`. Its build graph
holds the main checkout's root path. On the first open, Bee compiles some assemblies with that path, and Unity's
source generator writes absolute script paths into them. Unity binds scripts by project-relative path, so nothing
binds. Later passes do not rebuild those DLLs.

Spike timings on paint-crafter (3.6 GB Library, btrfs reflink copy in 1.5 s):

| Library of the new worktree | PlayMode gate | Result |
| --- | --- | --- |
| copy as is | 121 s | fails, 4021 `(Unknown)` lines |
| copy, then delete `Library/Bee` (0.05 s) | 100 s | passes, 0 lines |
| copy, then delete `Library/Bee` and `Library/ScriptAssemblies` | 100 s | passes, no gain |
| copy, then delete `Library/ScriptAssemblies` only | 126 s | fails |
| no copy (fresh Library) | 175 s | passes, but leaves a diff in a vendored file |

Any Library copied with its `Bee` breaks, however clean the source. The import cache (`ArtifactDB`,
`SourceAssetDB`) is fine to copy.

## Decision

- A Unity worktree still gets a copy of the main checkout's `Library/` (ADR 0018, R10.2). Right after the copy,
  pi-spore deletes `<worktree>/Library/Bee`. Unity rebuilds its script build graph on the first open (10–17 s).
- The seam: a trait may declare `afterCopy(copyPath)`. The workspaces module calls it after `copyIgnoredFiles`, for
  every isolation except `in-place`. Lane workspaces and the run's merge checkout both come from
  `workspaces.create`, so both get it. A failing hook fails the creation and removes the new copy, as a failed copy
  does.
- Never a symlink or a shared Library. Never a change to the main checkout's Library. If the main checkout's
  `Library` is a symlink, `cp -a` copies the link, and deleting `Bee` through it would change the shared folder. So
  the hook refuses with 409 `symlinked_library`, and the new copy is removed.
- The Unity test gates check the Editor log after `unity test` ends. When `<worktree>/Logs/Editor.log` was written
  by this run and has at least 100 lines that are exactly
  `The referenced script (Unknown) on this Behaviour is missing!`, the gate fails with
  `stale Unity Library cache in <worktree>: <n> missing-script lines. Run the unity-repair-library action, then Retry.`
  It does this for any exit code. A broken copy gives thousands of such lines; a good one gives 0. The threshold
  leaves room for a project with a few real missing scripts. The gate only counts lines: the log echoes the
  command line with an access token, so none of its text goes into the message.
- The gate does not repair and retry on its own. The user or an agent runs the provided action
  `unity-repair-library` on the workspace. It deletes `<worktree>/Library/Bee`. It refuses the main checkout and a
  folder that an editor has open, and logs only paths.

## Consequences

- New Unity worktrees pass gates without a manual reimport, and the first gate is faster than with the old copy.
- Worktrees made before this change keep their bad DLLs until `unity-repair-library` runs on them; the gate's
  message says so.
- If another Unity version adds a new path-bound cache inside `Library/`, the health check names the symptom, and the
  repair needs a new ADR.
