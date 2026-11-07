# 0031. spore-bridge replaces the global AGENTS.md in agents with pi-spore's rules

- Status: Accepted
- Date: 2026-11-06
- Requirements: R1.4, R3.5, R7.5

## Context

pi-spore agents load the user's whole Pi setup (R1.4), including the global `~/.pi/agent/AGENTS.md`. That file
describes work outside pi-spore: delegation through Orca terminals, subagent briefs, and asking with the `ask_user`
tool. Inside pi-spore, an agent's workspace, worktree, and checks are managed for it, and it asks the user with
`request_human_input`, which survives restarts (ADR 0008). Rules that point the agent at Orca would be wrong there.
The user's global file must not be edited for pi-spore (open question Q16).

Two ways were weighed: a role prompt passed with `--append-system-prompt` that tells the agent to ignore the
Orca-specific parts, or spore-bridge changing the prompt itself. The user chose the second.

## Decision

- spore-bridge handles `before_agent_start` on every run. It removes the context files that sit directly in Pi's
  agent folder (the global `AGENTS.md` and its variants) from `systemPromptOptions.contextFiles`, and adds a
  `pi_spore_rules` section with pi-spore's rules (`pi-extensions/spore-bridge/src/rules.ts`).
- Project `AGENTS.md` files still load.
- Advice for each bridge tool lives in its `promptGuidelines`, so it shows only while the tool is active.
- Outside pi-spore (no `PI_SPORE_URL` or `PI_SPORE_TOKEN`), spore-bridge changes nothing and warns that its tools
  are off.

## Consequences

- Agents in pi-spore no longer see the user's general rules, such as writing style. Rules the user wants in
  pi-spore agents must go into `rules.ts` or the project's `AGENTS.md`.
- The global file and the `pi` CLI are unchanged.
- Pi rebuilds the prompt options for each run, so the change is applied on every run. A Pi change to
  `systemPromptOptions` must be tracked in `rules.ts`.
