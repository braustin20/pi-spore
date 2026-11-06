# 0020. Name and data layout

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.1, R17

## Decision

Product and CLI name: `pi-spore`. Data in `~/.pi-spore/`. Project config in `<project>/.pi-spore/config.toml`,
local override in `<project>/.pi-spore/config.local.toml`. Default branch: `main`.

## Consequences

- Projects should gitignore `.pi-spore/config.local.toml`. pi-spore warns if it is not ignored.
