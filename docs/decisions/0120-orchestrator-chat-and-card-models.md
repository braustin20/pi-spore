# 0120. The workspace chat is an orchestrator; cards choose its model; workers are subagents on `spore/auto`

- Status: Proposed
- Date: 2026-11-07
- Requirements: R3.1, R3.2, R3.4, R4.1, R11.4

## Context

- ADR 0013 maps the workspace's chat to the role `worker`. A new chat starts on `subagents.agentOverrides.worker`
  from Pi's settings, today Sonnet 5.5 at `high`. A card start sets no model (ADR 0100).
- In the user's Pi setup, `worker` is a subagent: it gets one bounded brief and writes code for it. The chat that
  holds the whole feature is the parent, which the user's rules call the orchestrator.
- `spore/auto` decides once, on the first user message of a session, and the choice sticks (ADR 0009). A chat's
  first message is a vague card brief. A worker subagent's first message is a bounded brief, the input the router
  is built for.
- The router's cloud model is `router.cloud`, or else the `worker` model (`pi-extensions/router/src/index.ts`). If
  `worker` became `spore/auto`, the router would route to itself.
- The user's older rules (paint-crafter `AGENTS.md`) say the parent writes the code by default. They delegate
  only when the work cannot fit one context, is wide rather than deep, or the user asked. The reason is a
  benchmark: delegated workers wrote two to three times the code of the parent and missed existing seams. The
  user now wants the pipeline's `implement` stage to run on a worker (R4.9), with the orchestrator checking the
  result for conciseness. This ADR replaces the older rule for pi-spore. Read-only helpers (`scout`, `researcher`,
  `reviewer`) are always allowed. A worker gets a fresh, compact brief with one outcome, named edit boundaries,
  acceptance checks, and a handoff contract.
- ADR 0007 describes a coordinator over many lane workspaces (v1, built last). That is a different thing. The
  orchestrator here is the chat of one workspace.

## Decision

**1. The workspace chat is the orchestrator.**

- Its role is `orchestrator`. It reads `subagents.agentOverrides.orchestrator` (model, thinking) from Pi's
  settings, as ADR 0013 does for other roles. pi-spore hardcodes no model. The user adds
  `claude-bridge/claude-opus-5-5` there once.
- Names inside pi-spore stay as they are: the `worker` kind in the table, `PI_SPORE_CHAT_KIND`, and the routes. The
  UI and docs say "orchestrator chat". ADR 0030 still holds: one active orchestrator chat per workspace, any
  number of read-only side chats.
- With no `orchestrator` override, a new chat starts on Pi's own default, as roles without an override do today.

**2. The model of a new chat is chosen in this order.**

1. The model picked in the start dialog.
2. The card's model, if the card has one.
3. `agentOverrides.orchestrator` from Pi's settings.

- A card gets an optional `model` (`provider/id`). The user sets it on the card.
- Every place that starts work from a card shows a model dropdown next to its existing ones, preselected with the
  card's model: the board's "new workspace" form, the board's "existing workspace" form, and the `card-start`
  approval on Home. On Home, approving with a changed model uses the existing "approve with a changed subject"
  step (ADR 0100); the subject gets an optional `model`.
- The chosen model is stored on the new chat (`agents_agents.model`, nullable) and passed as `--provider` and
  `--model` on its first start. Thinking still comes from the role default. A resumed session keeps its own model.
- A start in an existing workspace reuses that workspace's chat, which keeps its model. The dropdown is disabled
  there and says why.
- The user picking a model is the approval (R3.4). The tier check of ADR 0014 applies only to models an agent asks
  for.

**3. Workers are subagents on `spore/auto`.**

- The user sets `subagents.agentOverrides.worker.model` to `spore/auto`. The orchestrator starts a worker with the
  `subagent` tool and a bounded brief. The router decides on that brief, and the choice sticks for that worker run.
- `router.cloud` must name a real model. The router refuses `spore/auto` as its own cloud model and says which
  setting to fix. It does not fall back to the `worker` model when that is `spore/auto`.
- **The orchestrator plans and a worker implements.** The pipeline's `implement` stage is a separate `worker`
  agent (R4.9). The orchestrator does not write the feature code. It may make tiny corrections and edit docs.
- **The conciseness check.** After every worker run the orchestrator reads the real diff against the plan. Extra
  validation, duplicated types, code that skips an existing seam, and changes outside the brief are too verbose.
  It sends a fresh worker the goal, the current diff, and the exact cuts to make. After three passes without
  success it re-splits the task or takes it over.
- The user's yes to the plan covers its workers. The plan names the slices, and says they run on `spore/auto`.

**4. The orchestrator's rules** go into pi-spore's rules in spore-bridge (`rules.ts`, ADR 0031), because agents in
pi-spore do not see the user's global `AGENTS.md`. Draft:

```text
You are the orchestrator of this workspace: the chat that owns the feature from the card to the finished branch.

Plan
- Read the card, the project's AGENTS.md, and the docs it points to. Stop there.
- Start `scout` for repository discovery and `researcher` for outside facts before you read code deeply. Read their
  findings. Start another round only if they are not enough.
- Ask the user about real design forks, in one batch, with request_human_input. Do not ask about routine choices.
- Write the plan: the outcomes, the files, the invariants, the checks. Offer a `reviewer` pass on the plan. Run it
  only if the user says yes.

Build
- You plan and check. A worker writes the feature code. You may write failing tests first when that makes the brief
  exact, edit docs, and make tiny corrections.
- Send the plan to the user with request_human_input before the first worker. Name the slices and say they run
  on spore/auto. The user's yes covers every worker for this plan.
- One brief, one outcome. Give each worker the goal, the files it may edit and where to start reading, one example
  of the pattern to copy, the invariants, the pass or fail command, and what to report. Give it a fresh context,
  not this conversation.
- Only one writer works in the worktree at a time. Wait for a worker to finish before you start another.
- After every worker, read the real diff. Do not trust the report alone.
- Check for conciseness. Extra validation, duplicated types, code that skips an existing seam, and changes outside
  the brief are too much. Send a new worker the goal, the current diff, and the exact cuts. After three passes
  without success, split the task again or take it over.
- A worker that finds new work reports it. You decide what happens next.
- A fix pass is a new worker with the goal, the current diff, and the newest failure output.

Finish
- Run check and the tests. Prove each new test can fail. Report what you did, whether it worked, and what the user
  must decide.
```

## Relation to planned cards

- **Wire the router into pipelines (R4.9).** It makes the pipeline's `implement` stage use `tier = "route"`. With
  decision 3 the `worker` role is already on `spore/auto`, so the stage gets the router with no extra code. That
  card also asks for a chat notice per routing decision. The model picker now names the routed model, so the card
  keeps only the part about the usage-pressure approval (R4.10) and the queue status (R4.5).
- **Build review pipelines (R6).** The default pipeline starts with `implement` (role `worker`, `tier = "route"`).
  That matches this ADR: a separate worker agent runs it, and the orchestrator plans and checks. Architecture
  section 8 needs no change.
- **Build coordinator runs and lanes (R7).** The coordinator is the orchestrator of a run over many lane
  workspaces. A lane is a workspace with its own orchestrator chat. The lane model override (R4.8) and the card
  model of decision 2 are one mechanism: a model stored on the new chat. The model field and its column must come
  first.
- **Start runs from cards (R11.4).** It changes the same start dialog as decision 2. The model dropdown lands
  first. A run start then applies the chosen model to the coordinator.
- **Job runner, artifacts module.** No overlap. Later, the orchestrator can write worker briefs as artifacts.

## Consequences

- The default chat model moves from Sonnet to the orchestrator setting, and the user can override it per card or
  per start. Sonnet and the router are used where the work is bounded.
- The worker brief is the router's input, so routing gets better data than a chat's first message.
- The orchestrator reads every diff, so its model's quota pays for review, not for the bulk of the code.
- `AGENTS.md` of a project that says "the parent writes the code" (paint-crafter) conflicts with this. A project
  `AGENTS.md` still loads in pi-spore agents. The user decides whether to change it.
- The orchestrator rules are a draft. The user tunes them from real runs.
- pi-spore must keep working with a settings file that lacks `orchestrator`. It then uses Pi's default model.
- Open points for the build:
  1. The dropdown needs a model list when no chat is running. Today the list comes from a running chat
    (`get_available_models`). The build must pick a source and count its cost against `agents.maxLive`.
  2. A pi-subagents `worker` run in the chat is shown as a child run (ADR 0034). Its resolved model shows there.
- Build order, one card each: (1) `orchestrator` role and the `router.cloud` check; (2) card `model` field and
  `agents_agents.model`; (3) the model list route; (4) dropdowns on the board and on Home; (5) orchestrator rules
  and UI wording.
