# 0025. pi-spore agents run without pi-lens and get a `check` tool

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.4, R3.7, R6.3

## Context

pi-lens runs language servers for each agent and checks every edit. Spike Q1 measured about 410 MB per agent for
the TypeScript server alone. A review of 202 past Pi sessions ([notes](../spikes/pi-lens-value.md)) found:

- Agents call pi-lens tools directly in only 3% of tool calls.
- pi-lens blocked 29% of C# edits in Unity projects. Most blocks were "type not found" for types that exist. Unity
  adds a new file to the `.csproj` only when the editor refreshes, so the language server cannot see new types.
  These false alarms stop the agent and cost turns.
- pi-lens blocked 4% of TypeScript edits, mostly for real type errors.

A language server hosted by pi-spore would read the same out-of-date `.csproj` files. In Unity, only Unity's own
compiler is accurate.

## Decision

- pi-spore starts agents with `--no-extensions` and loads an explicit list with `-e`: the user's configured
  extensions and packages, minus a setting `agents.excludeExtensions` (default: `["npm:pi-lens"]`), plus
  spore-bridge. The user's `pi` in a terminal keeps pi-lens.
- spore-bridge adds a `check` tool. It runs the project's `check` action (for example `tsc`, Biome, or
  `unity recompile` when the agent holds the Unity editor lease) and returns the errors.
- Pipeline gates still run the full checks before work passes.
- A shared language server per worktree, hosted by pi-spore, is a v2 option if instant TypeScript feedback is
  missed.

## Consequences

- About 410 MB less per agent, and no false C# alarms.
- Agents find type errors when they call `check` or at the gate, not after every edit. Agent prompts must tell them
  to call `check` before they report done.
- pi-spore must resolve the user's extension list itself, the same way Pi does. A Pi change to package resolution
  must be tracked in one adapter.
