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
- Versions are checked against the registry when a dependency is added, not taken from this document.
- TypeScript 7.0.2 (the native compiler) builds the project references with `tsc -b`. Checked when the skeleton
  was built.
- Workspace packages export their `src/*.ts` under the `@pi-spore/source` condition. TypeScript, Vitest, and Vite
  resolve that condition, so tests and the web build use sources. Node uses the built `dist/` files.
- Biome formats and lints code and JSON. It skips Markdown, so docs keep their hand-wrapped layout.
