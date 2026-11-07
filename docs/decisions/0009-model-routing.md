# 0009. A router virtual model sends bounded tasks to local models

- Status: Accepted
- Date: 2026-11-06
- Requirements: R4.1, R4.2, R4.3, R4.4, R4.7, R4.9, R4.10, R3.4

## Context

Strata (local, 128k context, weaker than Sonnet) is free and good enough for bounded implementation tasks: the
kind sent to Haiku, Luna, or the implementer subagent. It is not good enough for visual work, vague requirements,
or design. Pi 1.5.0 supports virtual models (`pi.registerVirtualModel`) and classifier calls
(`ctx.modelRegistry.classify`), and ships a `jev-router.ts` example. TypeSafe Jev is in the user's model list. In
the user's setup only the OpenRouter listing has credentials: `openrouter/~typesafe/jev-latest` works,
`typesafe/jev-latest` does not (checked 2026-11-06; one call cost about $0.00002).

## Decision

A pi-spore Pi extension registers `spore/auto`. On the first user message of a session it:

1. Estimates tokens and rejects tasks that do not fit the local budget.
2. Asks Jev whether the task is bounded, explicit, non-visual, and straightforward.
3. Routes to a local target only if all checks pass. Otherwise it routes to the cloud model for the role.

The choice is sticky for the session. A context overflow or repeated gate failure escalates to cloud. Choosing
`spore/auto` for a role counts as approval for whatever it picks. Every decision is recorded with its reasons. Work
done on a local model must pass review by a stronger model; the pipeline enforces this with `min_strength_over`.
Under subscription usage pressure (ADR 0022) the router accepts bounded tasks at lower Jev confidence.

- The classifier is a setting (`router.classifier`), default `openrouter/~typesafe/jev-latest`.
- Decisions are appended to `~/.pi-spore/usage/routing.jsonl`, which the usage module reads. The router state on
  the session branch keeps the route and its reasons as well. Plain `pi` and pi-spore write the same file.
- The router never crashes a session. On its own errors it routes to the cloud model, pins the session there, and
  records the error.
- The decision logic is a pure function (`decide`) tested without models; the extension only gathers its inputs.

## Consequences

- The same router works in plain `pi`.
- Routing adds one Jev call (latency and a small cost) per new session.
- Thresholds need tuning from recorded outcomes.
