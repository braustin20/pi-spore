# 0018. Gitignored files reach new worktrees through a declared copy list

- Status: Accepted
- Date: 2026-11-06
- Requirements: R2.6, R10.2

## Context

New worktrees miss gitignored files (Unity `Library`, `.csproj`, `.sln`, `.env`). Copying must not leak secrets.

## Decision

`[worktree] copy = [...]` in `<project>/.pi-spore/config.toml`, with Unity defaults when detected. Files are
copied with reflink where possible. pi-spore never reads copied files into logs, transcripts, or artifacts. The
`setup` action runs after the copy.

## Consequences

- The common case needs no script.
- Agents can still read `.env` in their worktree with their own tools; the copy list does not hide files from them.
