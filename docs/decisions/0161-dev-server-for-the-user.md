# 0161. The dev server keeps its home and has a sample project

- Status: Accepted
- Date: 2026-11-09
- Requirements: R12.3
- Amends: [ADR 0160](0160-guard-the-server-from-agents.md)

## Context

- The user wants to test a workspace's changes before a merge: click Run on `dev`, open the server, try it.
- ADR 0160's dev server used a temp home that it removed on exit. Every run started empty, with no project, so
  there was nothing to try.
- The user chose a fresh home with one test project over a copy of their real data.

## Decision

- `scripts/dev-server.mjs` uses `<worktree>/.pi-spore-dev/home`, gitignored and kept between runs. To reset it,
  delete `.pi-spore-dev/`.
- The first run makes `.pi-spore-dev/sample-repo`, a new git repo with one commit, and adds it as a project through
  the dev server's API. The real repo and the worktree are never added: they share `.git` with the real project,
  so dev branches would show up there.
- The env drops the same `PI_SPORE_*` names as `[actions.test]`, and the script prints one line,
  `pi-spore dev server: http://127.0.0.1:<port>/`, once the server answers `/api/health`.
- The Actions panel links loopback URLs in a log and shows Open for a running run whose log has one.

## Consequences

- Agents that run `dev` in a worktree share the home with the user's runs there.
- Two dev runs in one worktree cannot run at once: the second fails on the home lock.
- The dev server's agents use real models and spend tokens.
