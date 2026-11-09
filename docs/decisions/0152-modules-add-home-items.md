# 0152. Modules add items to Home through sources

- Status: Accepted
- Date: 2026-11-08
- Requirements: R9.2, R15.1, R15.2, R18.4

## Context

Home (the attention module) built its inbox from agent state, questions, approvals, and jobs. Three documented items
had no way in: a PR watch that waits for the user (R9.2), overdue and due-today cards (R15.1), and usage warnings
(R18.4, shown only on the Usage page). This was open question Q18.

## Decision

- Attention exports `HomeItemsKey`. A module calls `register(name, source)` once, where `source()` returns the
  items true now: `{ id, at, title, detail?, href }`. Attention stores nothing for them.
- Attention reads every source each time it builds the inbox. The item shows while the condition holds and goes when
  it clears. It becomes a `notice` inbox item with the source's name, so it reaches `GET /api/attention/inbox`, the
  `attention:inbox` topic, and desktop notifications like any other item. The notice key is `source` plus `id`.
- `changed()` on the same key builds and pushes the inbox on the next tick. A module calls it where its condition
  changes. This is a pull with a nudge, not a second topic, so Home has one place to read and one push path.
- A notice has no chat or workspace fields: its `href` opens the module's page. Home shows it as a card with an Open
  link.
- github-pr, kanban, and usage register sources and require `attention`. The PR tab, the board, and the Usage page
  keep their displays.

## Consequences

- Kanban uses the board's local calendar day (`localDay`, `dueState`), so Home and the board agree. A card that turns
  overdue at midnight shows at the next inbox build (a page load or any change), not at midnight.
- Usage reads plan files that the router writes from any Pi process. The module watches the usage folder and calls
  `changed()` when a plan file (`*.json`) changes, so a threshold crossing reaches the topic and desktop
  notifications without another change. It keeps no copy of the last warnings: they also clear with time, and Home
  reads them fresh on every build. The watcher does not keep the process alive.
- A source runs on every inbox build, so it must be cheap. A source that throws is logged as an error and skipped,
  so one broken source does not blank Home.
- A source may be slow, so builds can end out of order. Only the newest build publishes; an older one is dropped.
