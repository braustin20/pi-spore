# 0005. VCS behind a provider interface

- Status: Accepted
- Date: 2026-11-06
- Requirements: R2.1, R2.4, R2.5

## Context

v1 needs Git and plain folders. Perforce or others may come later.

## Decision

A `VcsProvider` interface and registry. v1 ships `git` and `folder`. Interface words are neutral ("line",
"record", "publish"). Optional capabilities are detected by presence. Nothing outside a provider branches on the
kind. Providers run `git` and `gh` with `execFile`, never a shell.

## Consequences

- Some Git features look indirect in core code.
- Adding a provider does not touch modules.
