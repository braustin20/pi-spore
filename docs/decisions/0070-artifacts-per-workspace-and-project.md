# 0070. Artifacts per workspace and per project, outside Git

- Status: Accepted
- Date: 2026-11-07
- Requirements: R14

## Context

R14 planned one artifacts folder per workspace, outside every working copy. Decisions, spikes, and notes often
outlive the workspace that made them, and the user does not want them in Git. Agents had no way to write
artifacts, and there was no viewer for Markdown files inside the repository.

## Decision

- Two scopes, both outside every working copy and never committed:
  - workspace artifacts in `~/.pi-spore/artifacts/workspaces/<workspace id>/`: plans, briefs, reports, verdicts,
    test proofs for one piece of work;
  - project artifacts in `~/.pi-spore/artifacts/projects/<project id>/`: decisions, spikes, notes shared by all
    workspaces of the project.
- A workspace artifact can be promoted to its project (a copy; the original stays for history).
- Agents write and read artifacts through spore-bridge tools (`write_artifact`, `read_artifact`,
  `list_artifacts`), limited to their own workspace and its project.
- One viewer for artifacts and for files inside the repository: Markdown rendered, images shown, HTML previewed in
  a sandboxed frame, other text shown as code.
- Artifacts are kept after archive. Removing a project does not delete its artifacts without an explicit yes.

## Consequences

- Agents get a place for plans and notes that keeps the worktree clean.
- The viewer serves files from disk, so its routes are a security boundary: only the two artifact folders and the
  workspace's own folder, after resolving symlinks.
