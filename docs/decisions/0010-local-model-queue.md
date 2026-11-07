# 0010. Local models run one job at a time; others wait

- Status: Accepted
- Date: 2026-11-06
- Requirements: R4.5, R4.6

## Context

Strata serves one model on one GPU. Two sessions interleaving requests would each force a reload of up to 128k
tokens of prompt cache.

## Decision

Each local target has a concurrency setting (Strata: 1). A session routed to a local target holds a slot through a
lock file, `$XDG_RUNTIME_DIR/pi-spore/<target>.<n>.lock`, one file per slot. pi-spore agents and plain `pi` use the
same files, so there is no server slot: one mechanism is simpler, and it also counts terminal sessions. The file holds
the pid, and a lock of a dead process is taken over.

The slot is held for one agent run: taken before the run's first local request, freed when the run settles
(`agent_settled`), on session shutdown, and on escalation to cloud. Others wait, with a "Waiting for <model>" status
and chat notice. A second local server is added as another target in settings.

The router does not start servers. Before a run's first local request it emits `pi-spore:local-route` on Pi's event
bus with `{ provider, modelId, ctx, wait }`. The extension that runs the target (for Strata, `strata-model.ts`)
starts it and hands its "ready" promise to `wait`. The router then checks the target's `healthUrl`. If either fails,
the task goes to cloud.

## Consequences

- Strata itself queues a second request and never rejects it in the user's setup
  ([spike Q3](../spikes/q3-strata-concurrency.md)). The slot exists to avoid reprocessing long prompts, not to avoid
  errors. pi-spore treats a `queue_wait_timeout` error as busy and retries.

- Between two runs of one session another session can take the slot, which costs a prompt reload. Holding the slot
  for a whole pipeline stage needs the pipeline module; this can be revisited then.
- Local lanes run one after another. Throughput is lower but cost is zero.
- Strata start and stop stay with `strata-model.ts`.
