---
name: project-wiki
description: Keep a project's docs findable and current with one docs/index.md map, and lint the docs for stale or orphan pages. Use when you look for a project's docs, add, rename, or remove a doc, an ADR, or a top-level section, set up an index for a project that has none, or run a docs lint that checks the index and checks doc claims against the code.
---

# Project wiki

A project's docs are a small wiki. `docs/index.md` is its map. Every doc is linked from the map. A lint pass finds
pages that are stale or missing from the map. Git history records the changes, so there is no change log.

## The index

- `docs/index.md` is the map of the project's docs. Start there to find a doc.
- One line per page: a relative link, then one sentence that says what the page holds.

  ```markdown
  - [vision.md](vision.md): the requirements, numbered R1 to R18.
  ```

- Group the lines under short headings. For example:
  - **Overview**: the vision, the design, the open questions.
  - **Architecture**: one line per top-level section of a long doc, with an anchor link, such as
    `[Agent runtime](architecture.md#2-agent-runtime)`.
  - **Decisions**: one line per ADR, with its number, title, and status, such as
    `- [0031](decisions/0031-agent-rules-from-spore-bridge.md): spore-bridge replaces the global AGENTS.md. Accepted.`
  - **Spikes**: one line per spike.
  - **Other**: the rest.
- The project's `AGENTS.md` points to the index.

## Keep it current

- When you add, rename, or remove a doc, an ADR, or a top-level section, update the index in the same change.
- When an ADR's status changes, update its line.
- Docs describe what is true now. When code changes what a doc says, change the doc in the same change.

## Set it up

For a project with no `docs/index.md`:

1. List every markdown file under `docs/`, and the top-level sections of each long doc.
2. Read the first lines of each one. Write one sentence for each.
3. Write `docs/index.md` with the headings above.
4. Add one line to the project's `AGENTS.md`: start with `docs/index.md`.

A planner chat cannot write files. It adds a card for the setup instead, and an orchestrator does the card.

## Lint (read-only)

A lint changes no files. It reports findings.

1. Check the index:
   - Every markdown file under `docs/` is linked from the index.
   - Every link in the index resolves to a file, and every anchor to a heading.
   - Every ADR file has its line.
   - No two ADR files share a number.
2. Check a sample of claims against the code. Pick the docs that changed least recently, or that the current work
   touches. Check that the files, functions, settings keys, commands, and routes a doc names exist, and that they do
   what the doc says.
3. Report each finding with:
   - the doc and the line;
   - what is wrong;
   - the evidence: a file and line in the code, or the missing path.

A planner chat starts `scout` helpers for step 2, then adds one card per stale doc. Other chats report the findings
to the user.
