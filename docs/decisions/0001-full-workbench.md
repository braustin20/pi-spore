# 0001. Full workbench with a browser UI that replaces Orca

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.1, R1.3, R13

## Context

Agent work across worktrees is coordinated by hand in Orca. Unity projects need per-repo setup scripts for
`Library` copies and a custom quick command to start Unity. A plugin for an existing agent CLI cannot own
worktrees, pipelines, a board, and Unity editors. A desktop shell (Electron or Tauri) adds build work and gives
little a local web page cannot.

## Decision

Build a local server, a browser UI, and a thin CLI from the start. pi-spore replaces Orca for agent and Unity
work, so v1 includes terminals (node-pty + xterm.js), worktree setup, and Unity launch.

## Consequences

- Terminals move into v1 scope.
- A desktop wrapper stays possible later without changing the server.
- Your Orca-specific Pi extensions (`orca-*.ts`) are inert outside Orca and need no change.
