# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Spikes (answer with a small experiment before or during the skeleton)

- **Q3. Strata concurrency.** What does `serve/server.py --engine strata` do with a second request while one is
  running: queue it, run it in parallel, or reject it? The slot lock (ADR 0010) is required either way, but the
  error handling differs.
- **Q11. Codex plan windows.** Where do Codex 5-hour and weekly numbers come from in Pi? pi-ai 1.5.0 shows no
  `x-codex-*` headers. Candidates: response headers on the `openai-codex` provider, or Codex session `token_count`
  events. (ADR 0022)

- **Q15. C# language server cost.** In a Unity worktree, pi-lens starts a C# language server (`csharp-ls` or
  OmniSharp). Measure its memory and start time per agent, and decide whether read-only roles skip it.

## Later

- **Q5. pi-subagents child runs.** How does pi-spore observe helpers a worker starts through pi-subagents: their
  run files under `~/.pi/agent/pi-subagents/`, or events the extension emits? (ADR 0013)
- **Q13. Agent process limits.** Idle timeout before an agent process stops, and the maximum number of live agent
  processes. Spike Q1 measured about 0.5 GB per idle agent and 0.9 GB per busy one
  ([spike notes](spikes/q1-rpc-agents.md)). Proposal: at most 4 live agents by default, stop an agent process after
  10 idle minutes, and set `PI_LENS_LSP_IDLE_EVICT_MS` to 2 minutes for agents.
- **Q14. GitHub workflows.** Some projects have Claude GitHub workflows (for example `claude.yml` and
  `claude-code-review.yml`). They may
  review the same PRs pi-spore watches. Decide whether PR watch ignores their comments or feeds them to the worker.
