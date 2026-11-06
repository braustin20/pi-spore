# 0012. Kanban board in the workbench database replaces todos

- Status: Accepted
- Date: 2026-11-06
- Requirements: R11

## Context

The user is a solo developer and wants to track work and hand it to agents without Jira. Markdown cards in repos
would be per-project and cause merge conflicts.

## Decision

One board across projects, stored in SQLite, with fixed columns (Backlog, Ready, In progress, Review, Done). Cards
start workspaces or runs and move with their state. Agents add cards through spore-bridge only when asked. It
replaces the plan's separate todo list.

## Consequences

- Cards are not in Git. Backup is the database file.
- Custom columns are a later change.
