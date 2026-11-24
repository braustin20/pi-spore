# 0193. pi-spore ships a project-wiki skill and a docs rule to every agent

- Status: Accepted; adds to [0031](0031-agent-rules-from-spore-bridge.md)
- Date: 2026-11-23
- Requirements: R1.4, R3.5

## Context

- pi-spore agents find docs with `grep`, `find`, and `read`, and with `scout` and `researcher` helpers. There are no
  embeddings and no vector store. Claude Code and Codex work the same way. A 2026-11-16 paper ("Embeddings vs.
  Grep", arXiv 2611.20455) found that the agent's search tool barely changed the result. The model mattered more.
- pi-spore itself has about 96 ADRs and a 2,324-line `docs/architecture.md`, and no index. Nothing checks that the
  docs still match the code.
- A 2026-11-10 test (tryglen.com, "context management strategies") found that a stale doc that conflicts with the
  rules wins 95 to 100% of the time, and the agent never tells the user.
- Karpathy's "LLM Wiki" pattern keeps an index page, linked pages, and a lint pass. pi-spore needs a cut-down form
  of it, for every project it runs, without each project copying it.
- The user picked this over agent memory files, because memory files go stale.

## Decision

- pi-spore ships the skill `pi-skills/project-wiki/SKILL.md`. It holds the pattern: a `docs/index.md` map with one
  line per page, kept current in the same change as the docs; how to set the index up; and a read-only docs lint
  that checks the index and a sample of doc claims against the code.
- Every agent loads it. `modules/agents/src/launch.ts` lists it in `SPORE_SKILLS`, and `resolveResourceArgs` adds
  `--skill <path>` after the user's skills, unless the user's setup already loads that path. This is the same way
  `SPORE_EXTENSIONS` load.
- spore-bridge appends one `DOCS_RULES` text to the rules of every role (ADR 0031): when the project has
  `docs/index.md`, start there to find docs; when you add, rename, or remove a doc, update the index in the same
  change; the project-wiki skill has the format, the setup, and the lint.

Left out:

- No embeddings and no vector store.
- No `log.md`. Git history records the changes.
- No scheduled lint. The user asks a planner chat for one.

## Consequences

- A project with no `docs/index.md` loses nothing: the rule applies only when the index exists, and the skill says
  how to set one up.
- Every role's prompt grows by one short paragraph. The skill's full text loads only when an agent uses it.
- A change to the index format goes into `SKILL.md`, not into each project.
