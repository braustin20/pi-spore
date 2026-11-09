# 0141. The router picks a rung on a ladder of cloud plans

- Status: Accepted
- Date: 2026-11-08
- Requirements: R4.1, R4.2, R4.3, R4.4, R4.7, R4.9, R4.10, R18
- Supersedes: the tier list defaults of ADR 0023, the spill list of ADR 0024, and the `router.cloud` setting of
  ADR 0009 and ADR 0120.

## Context

The router chooses between one local model and one fixed cloud model (`router.cloud`, else the pi-subagents `worker`
model). When that model's plan is full it spills to the first same-tier model in `router.spill` (ADR 0024). The user
wants each task on the cheapest model that still writes good code. From their experience:

- Rung 1 (Strata, Haiku, Luna): straightforward edits with a clean spec, not visual. Cheap and fast. They err on hard
  problems, so their work needs a close review (ADR 0120).
- Rung 2 (Sonnet, Sol, DeepSeek): medium tasks, not visual, somewhat complex. Sonnet and Sol write less concise code,
  so not for core infrastructure, foundational work, or novel features.
- Rung 3 (Opus, Astra, Sol on OpenRouter): design, visuals, gameplay feel, planning, large tasks, core
  infrastructure, foundational work, and novel features.
- Fable is for rare, deliberate use: complex planning or review, picked per card (ADR 0120) or for the reviewer role.

Facts checked on 2026-11-08:

- `pi --list-models` lists `claude-bridge/claude-{haiku,sonnet,opus}-5-5`, `claude-bridge/claude-fable-5-1`,
  `openai/gpt-6-luna`, `openai/gpt-6.1-sol`, `openai/gpt-6-astra`, `openrouter/openai/gpt-6-luna`,
  `openrouter/openai/gpt-6.1-sol`, and `openrouter/deepseek/deepseek-v4.1-flash-1017`. The user's Codex login is the
  `openai` provider; `openai-codex` is not logged in (ADR 0022).
- Pi's `getSupportedThinkingLevels(model)` (`@earendil-works/pi-ai`) says which levels a model takes. Every model
  above takes `high`. Luna takes `xhigh` on `openai` and on `openrouter`. Strata takes up to `high`. DeepSeek v4.1
  Flash takes `off`, `low`, `high`, and `max` only.
- Jev answers any number of questions in one call. Two more questions cost a few input tokens (about $0.000002), not
  another call ([docs](https://docs.typesafe.ai/cookbooks/parallel_questions.md)).
- `routing.jsonl` holds 49 decisions and no local outcome (ADR 0144). The calibration report has nothing to suggest.
- OpenRouter is paid per token. It sends no plan window, so its plan always reads "usage unknown".

## Decision

### Ladders

`router.ladders` is an ordered list of plans. Each plan has three rungs, cheapest first. Each rung names a model and
the thinking level the router uses for it. The router never uses the level the user picked for `spore/auto`.

| Rung | `claude` | `codex` | `openrouter` |
|---|---|---|---|
| 1 | `claude-bridge/claude-haiku-5-5`, `high` | `openai/gpt-6-luna`, `xhigh` | `openrouter/openai/gpt-6-luna`, `xhigh` |
| 2 | `claude-bridge/claude-sonnet-5-5`, `high` | `openai/gpt-6.1-sol`, `high` | `openrouter/deepseek/deepseek-v4.1-flash-1017`, `high` |
| 3 | `claude-bridge/claude-opus-5-5`, `high` | `openai/gpt-6-astra`, `high` | `openrouter/openai/gpt-6.1-sol`, `high` |

- Rung 1 tries the local target first (Strata, shared by every plan, with its own `thinking`, default `high`). The
  rung's cloud model takes the task when the local target cannot: no target, over its budget, or too many queued.
- A ladder's `plan` names its usage file (`~/.pi-spore/usage/<plan>.json`, ADR 0022). The task goes to the first plan
  that is not full, on the rung the rule picks. A plan with no fresh numbers counts as having room, and the reason
  says "usage unknown". When every plan is full, the request ends with an error that names the first reset and no
  state is stored, as in ADR 0024.
- Every ladder entry and local target is checked on each new decision: the model must be in Pi's catalog, must take
  its thinking level, must not be `spore/auto`, and must not be tier `top`. A failure is an error that names the
  setting, such as `router.ladders[2].rungs[1].thinking`.
- `router.cloud` and `router.spill` are removed. Either key is an error that names `router.ladders`. The router no
  longer reads the pi-subagents `worker` model.

### The rule for the rung

Jev gets six choice questions in one call: the four of ADR 0024, plus

- `foundational`: does the work build core infrastructure or foundations other code rests on, or a novel feature with
  no pattern to follow? Good answer: `routine`.
- `design`: does the task need design judgment or a sense of feel, such as architecture, API or UX design, planning,
  or gameplay feel? Good answer: `given`.

Jev is now asked for every new session, also when the task is over the local budget, because the rung needs it.

1. Rung 3 if the good answer of `visual`, `design`, or `foundational` is below `router.heavyThreshold`, or the token
   estimate is above `router.large`.
2. Else rung 1 if the good answers of `bounded`, `explicit`, and `straightforward` reach `router.threshold`
   (`router.pressureThreshold` under usage pressure on the chosen plan).
3. Else rung 2.

- Visual work now goes to rung 3, not only "not local" (ADR 0024). Usage pressure never lowers `heavyThreshold`, so
  pressure still never relaxes the visual check (R4.10).
- Explore (ADR 0144) still applies: when `straightforward` is the only rung-1 blocker, the task goes local.
- A classifier error sends the task to rung 3.

### Starting bars

The calibration report has no local outcome, so it suggests no bar. The defaults lean to the higher rung:

- `threshold` 0.7 and `pressureThreshold` 0.55 stay as in ADR 0024.
- `heavyThreshold` 0.7: a 30% chance that a task is visual, design, or foundational is enough for rung 3. In the
  recorded decisions, 5 of 33 have a visual answer below 0.7.
- `large` 100000 tokens: more than Strata's whole context (131072 tokens less its output). 8 of 49 recorded first
  messages are above it.

### The local queue

`router.maxQueued` (default 1) is the most sessions that may wait for a busy local target. A session that waits
writes a file next to the slot locks, `$XDG_RUNTIME_DIR/pi-spore/<target>.wait.<pid>.lock`, and removes it when it
gets a slot or stops. Files of dead processes do not count. When `maxQueued` sessions already wait, a rung-1 task goes
to the plan's rung-1 cloud model and does not wait. The default lets one task wait for the one ahead of it. A second
waiter would wait for two whole tasks, which is longer than Haiku or Luna takes, and those cost little.

### Tiers

The tier order becomes `local < light < medium < heavy < top` (ADR 0023). Defaults:

- local: Strata.
- light: Haiku 5.5, Luna (`openai`, `openai-codex`, `openrouter/openai`).
- medium: Sonnet 5.5, DeepSeek v4.1 Flash 1017.
- heavy: Opus 5.5, Sol 6.1 (`openai`, `openai-codex`, `openrouter/openai`), Astra (`openai`, `openai-codex`).
- top: Fable 5.1 (`claude-bridge`, `anthropic`).

Terra is removed from the tiers and from every default. A tier ranks strength for `min_strength_over` and lane
approvals. A rung is a place on a ladder. They differ: Sol 6.1 is rung 2 on Codex and tier heavy. The router never
routes to a `top` model.

### What stays

- Choosing `spore/auto` is the approval for whatever it picks (ADR 0009).
- The choice is sticky for the session. It holds the rung, plan, model, and thinking level. A state from before this
  ADR (no rung) is decided again once.
- Escalation is the only move: a context overflow, or the second failed request in a row, moves the session up one
  rung, on the first plan with room. This now applies on every rung below 3, not only on local. Rung 3 does not
  escalate.
- A settings error ends the request with its message. Any other router error routes to the first ladder's rung 3,
  pins the session there, and records `kind: "error"`.
- Each decision record has `rung`, `plan`, and `thinking`, with the reasons. New records use the routes `local`,
  `cloud`, and `wait`. `spill` stays readable in old records.
- The Usage page shows decisions, outcomes, and passes per rung and plan.

## Consequences

- Most tasks move off the user's chosen model to a cheaper one. Rung-1 and rung-2 work needs close review.
- OpenRouter has no plan window, so in practice the ladder ends there and spends money per token. To cap it, the user
  removes that ladder.
- The thinking level the user picks for `spore/auto` has no effect.
- Calibration has data only for the rung-1 bar. `heavyThreshold` and `large` are tuned by hand from the per-rung pass
  counts until there is more data.
- A new model must get a tier and, to be routed, a ladder entry.
