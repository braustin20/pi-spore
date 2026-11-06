# 0003. Features are in-repo modules with a typed contract

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.5

## Context

The workbench has many features with different lifetimes. Some must always be present. Others (Unity, GitHub PRs,
kanban) are optional per user.

## Decision

Every feature beyond the core is a package under `modules/<id>/` with a server entry and a web entry, `id`,
`requires`, `core`, and `setup(host)`. One plain-list registry on the server and one in the web app. Startup checks:
unique ids, required modules present and enabled, core modules not disabled, no cycles. Setup runs in dependency
order. Modules reach each other only through exported interface keys. No external plugins.

## Consequences

- Clear seams for parallel work and for tests with fakes.
- Some boilerplate per module.
- Cross-module imports of internals are a lint error.
