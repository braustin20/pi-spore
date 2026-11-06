# 0006. Declared review pipelines in TOML, user and project

- Status: Accepted
- Date: 2026-11-06
- Requirements: R6.1, R6.2, R6.3, R6.6

## Context

The worker → reviewer → adversarial flow lives in prompt templates and nothing enforces it. Unity projects need
different gates (batch-mode tests) than Node projects.

## Decision

A pipeline is a TOML file of stages (role, model or tier, thinking, rounds, gates). Files live in
`~/.pi-spore/pipelines/` and `<project>/.pi-spore/pipelines/`; a project file with the same id wins. Each stage is a
durable job. A pipeline run records the file hash it started with. No fixed state machine.

## Consequences

- Projects can ship their own gates with the repo.
- A pipeline edit does not change runs in progress.
