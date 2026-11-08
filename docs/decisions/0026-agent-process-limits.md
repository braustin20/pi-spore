# 0026. Agent process limits

- Status: Accepted
- Date: 2026-11-06
- Requirements: R3.6

## Context

Spike Q1 measured about 0.5 GB per idle agent and 0.9 GB per busy one with pi-lens. Without pi-lens (ADR 0025) an
agent uses about 0.2 to 0.5 GB. Unity editors need several GB each, and the machine often has little free memory.

## Decision

- At most 8 live agent processes by default (setting `agents.maxLive`). Work for a ninth agent waits in a queue,
  and Home shows it as waiting. The default was 4 until 2026-11-08; the user raised it after running several cards
  at once on a machine with 62 GB of memory.
- An agent process with no run, no queued input, and no open dialog stops after 10 idle minutes (setting
  `agents.idleStopMinutes`). Its session file keeps the conversation. It restarts with `--session` in about 1 s
  when it gets work.
- A stopped agent restarts quickly, so idleness must not block work. When a chat waits for a slot, pi-spore stops
  idle agents at once, longest idle first, until each waiting chat has a slot. An agent that is busy, has queued
  input, has an open dialog, or has running helpers (ADR 0034) is never stopped this way. The 10-minute idle stop
  stays for the case where nobody waits.

## Consequences

- Up to 4 agents can work at once. Larger runs take longer instead of using more memory.
- A stopped agent loses in-memory extension state. Extensions that need state across restarts must store it in the
  session, which is Pi's normal rule.
