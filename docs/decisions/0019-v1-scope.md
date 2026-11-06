# 0019. v1 scope

- Status: Accepted
- Date: 2026-11-06
- Requirements: Out of scope section

## Context

The source plan is large for one developer.

## Decision

Moved to v2: full-text search, MCP manager UI (v1 shows servers read-only), services with ports, snooze and
wait-on rules, BTW chat. Kept in v1: GitHub PR watch with auto-fix loop, coordinator runs with lanes, terminals,
Unity, kanban, routing, and subscription usage tracking.

## Consequences

- The store and transcripts are laid out so search can be added without migration pain.
