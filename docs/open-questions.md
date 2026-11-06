# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Spikes (answer with a small experiment before or during the skeleton)

- **Q3. Strata concurrency.** What does `serve/server.py --engine strata` do with a second request while one is
  running: queue it, run it in parallel, or reject it? The slot lock (ADR 0010) is required either way, but the
  error handling differs.
- **Q11. Codex plan windows.** Where do Codex 5-hour and weekly numbers come from in Pi? pi-ai 1.5.0 shows no
  `x-codex-*` headers. Candidates: response headers on the `openai-codex` provider, or Codex session `token_count`
  events. (ADR 0022)

## Later

- **Q5. pi-subagents child runs.** How does pi-spore observe helpers a worker starts through pi-subagents: their
  run files under `~/.pi/agent/pi-subagents/`, or events the extension emits? (ADR 0013)
- **Q14. GitHub workflows.** Some projects have Claude GitHub workflows (for example `claude.yml` and
  `claude-code-review.yml`). They may
  review the same PRs pi-spore watches. Decide whether PR watch ignores their comments or feeds them to the worker.
