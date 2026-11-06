# 0021. Tooling: Node 26 via .nvmrc and npm scripts, no mise

- Status: Accepted
- Date: 2026-11-06
- Requirements: none (engineering)

## Context

The source plan pinned Node 24 with mise. The user runs Node 26.7 through nvm and has no mise. Pi 1.5.0 needs Node
22.19 or newer.

## Decision

`.nvmrc` pins Node 26. `package.json` `engines` matches. Tasks are npm scripts: `npm run check` (Biome, then
`tsc -b`) and `npm test` (Vitest). Stack: TypeScript strict ESM, npm workspaces, Hono + ws, TypeBox, React + Vite,
Vitest, Biome, node-pty, `node:sqlite`. Dependencies are added only when code uses them, at exact versions.

## Consequences

- Nothing new to install.
- Versions are checked against the registry when the skeleton is built, not taken from this document.
