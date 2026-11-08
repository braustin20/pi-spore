# 0130. An agent merges a PR only on the user's word

- Status: Accepted
- Date: 2026-11-07
- Requirements: R9.3

## Context

- R9.3, ADR 0017, and ADR 0090 say pi-spore never merges. The chat rules say "A human merges".
- The user often asks a chat to commit, push, open a PR, and merge in one go. The rule made the chat refuse, and
  the user had to merge by hand.
- The risk the rule guards against is a merge the user did not want. A merge the user asked for does not carry
  that risk.

## Decision

- An agent may merge a PR into the base branch in two cases only:
  - the user asks for that merge in so many words;
  - the agent asks first, and the user says yes.
- Each yes covers one PR. A yes in one chat or for one PR does not cover the next.
- Nothing else changes. No agent enables auto-merge. pi-spore's own code still never merges, closes a PR, or
  force-pushes (ADR 0090): the merge is the agent's `gh pr merge`, run on the user's word. The PR watch still
  tells the worker not to merge, because the user did not ask.

## Consequences

- The user can finish a card from the chat.
- The chat rules (`pi-extensions/spore-bridge/src/rules.ts`), `AGENTS.md`, and R9.3 state the two cases.
- An agent must not read a general go-ahead ("finish the card", "ship it") as a yes to merge. When in doubt, it
  asks.
