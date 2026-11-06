# 0011. Unity support as a module: copy, editor lease, batch-mode gates

- Status: Accepted
- Date: 2026-11-06
- Requirements: R10

## Context

The user's Unity 6 projects (each with a `Library` of several GB) work in worktrees only with an Orca setup script that reflink-copies `Library`, `*.csproj`, and `*.sln`. Unity locks a
project while an editor has it open, so batch-mode tests cannot run there. The unity-mcp relay picks the first live
editor bridge, which can be the wrong project. The `unity` CLI can open, close, test, and report status as JSON.

## Decision

A `unity` module:

- detects Unity projects;
- sets the copy defaults for new worktrees;
- adds "Open in Unity";
- holds one editor lease per project (owner: user or an agent workspace);
- runs test gates with `unity test` in batch mode.

A gate waits for an agent's lease to end. For a user's lease it asks before closing, because `unity close` does
not save. Agents get `PI_SPORE_UNITY_PROJECT` so unity-mcp connects to their own worktree's editor.

## Consequences

- One editor per project means agents that need a live editor queue behind each other.
- An agent that needs a live editor creates an Approval on Home. It opens Unity only after the user says yes,
  because each editor takes several GB of RAM.
- `~/.unity/relay/unity-mcp.sh` (outside this repo) passes `--project-path "$PI_SPORE_UNITY_PROJECT"` to the relay
  when the variable is set. Without it, the script works as before.
