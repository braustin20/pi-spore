# AGENTS.md

pi-spore is a local, single-user agent workbench: a Node server, a React web UI, and a CLI that run Pi coding
agents across Git projects, with first-class Unity support. Read these before changing anything:

- `docs/vision.md`: requirements, numbered (`R4.2`). Cite them in commits and code comments where useful.
- `docs/architecture.md`: layout, module contract, domain model, and how each part works.
- `docs/decisions/`: one file per decision. Do not reverse a decision in code. Propose a new ADR instead.
- `docs/open-questions.md`: unsettled points. Do not guess an answer to one; ask.

## Principles

- KISS first. The simplest design that meets the requirement wins. DRY and SOLID serve that, not the other way
  around.
- Comments explain why, not what. No comment that repeats the code.
- Fail loudly at boundaries. Validate every external input (HTTP, files, config, child process output) with
  TypeBox schemas and reject it with a clear error. Inside the boundary, trust the types.
- No silent fallbacks. If a setting, model, or tool is missing, raise an error that names it.
- Run external programs (`git`, `gh`, `unity`, `pi`) with `execFile` and argv arrays. Never through a shell, unless
  an action is declared with `shell = true`.
- Never read secrets or copied gitignored files into logs, transcripts, or artifacts.
- pi-spore never merges to a base branch on its own, never enables auto-merge, never changes a role's model without
  approval, and never closes a Unity editor without an explicit yes. An agent merges a PR only when the user asks
  for that merge, or when it asks and the user says yes (ADR 0130). pi-spore's own code merges a PR only when the
  user clicks Merge in the PR tab and confirms (ADR 0142).

## Delegation (ADR 0120, ADR 0162)

- The chat plans and checks. The workspace pipeline writes the feature code: one slice is one `start_pipeline` run,
  its worker on `spore/auto`. The chat may write failing tests first, edit docs, and make tiny corrections.
- `scout`, `researcher`, and `reviewer` are always allowed. Ask the user before the first run, with the plan.
  That yes covers every pipeline run of the plan.
- One brief per run: one outcome, the files it may edit, one example of the pattern, the invariants, one pass or
  fail command. One run per workspace at a time; wait for its end message.
- After each run that passes, read the real diff and check it for conciseness: extra validation, duplicated types,
  code that skips an existing seam, and changes outside the brief go back as a new run with the exact cuts. After
  three runs, re-split the task or take it over.

## Module rules

- Every feature beyond the core lives in `modules/<id>/`, an npm package `@pi-spore/mod-<id>` with `src/server.ts`
  (the ServerModule) and `src/web.tsx` (the WebModule). The web entry must not import Node modules.
- A module reaches another module only through `host.use(key)` with an interface key the other module exports, and
  only if that module is in its `requires`. No imports of another module's internals.
- A module owns its tables and migrations. It never queries another module's tables.
- Register new modules in `packages/server/src/modules.ts` and `packages/web/src/modules.ts`. Keep the lists plain.
- Shared types and API schemas go in `packages/shared`. The module contract goes in `packages/module-api`.
- Module tests use `createTestServer` from `@pi-spore/server-core/testing`: real modules, a temp home, an in-memory
  store, a deterministic clock and ids. Real `git` in temp folders is fine.
- Read request bodies with `parseJsonBody`, so broken JSON answers 400. Throw `ApiError` for expected failures.

## Tooling

- Node 26 (`.nvmrc`). Run `nvm use` first.
- Install: `npm ci`
- Check: `npm run check` (Biome, then `tsc -b`). Must pass before every commit.
- Test: `npm test` (Vitest). Must pass before every commit.
- Format and safe lint fixes: `npm run format`
- Build everything: `npm run build`. Start the server: `npm start` (port 7420, or `PI_SPORE_PORT`).
- CLI after a build: `node packages/cli/dist/main.js health`
- Add a dependency only when code uses it, at an exact version. Check the current version with `npm view` first.
  Do not rely on memory for library APIs; read the installed package's docs or types.

## Testing rules

- Tests are deterministic: no network, no real models, no real clock, no sleeps. Use fakes:
  - a fake agent process in place of `pi --mode rpc`;
  - a fake `unity` CLI and a fake `gh`;
  - an injected clock;
  - an in-memory or temp-file SQLite store.
  Real `git` in a temp directory is allowed.
- Prove each new test can fail: break the code it covers, see the test fail, then restore. Say so in the handoff or
  PR description.
- Test behavior through public interfaces, not private helpers.
- A bug fix starts with a failing test that reproduces it.

## Commit rules

- Branch: `main` is the default. Work on feature branches.
- Small commits, one logical change each. Message: imperative subject under 72 characters, then a body that says
  why and cites requirements or ADRs (`R10.6`, `ADR 0011`).
- `npm run check` and `npm test` pass before each commit.
- Never commit secrets, `.env` files, `config.local.toml`, build output, or generated files.
- Do not push or open PRs unless asked.

## Writing style

- Plain, direct English in docs, comments, and UI text. Short sentences. No filler or mannered prose.
- Docs describe what is true now. Update them in the same change as the code.
