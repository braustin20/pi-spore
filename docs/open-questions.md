# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Spikes (answer with a small experiment before or during the skeleton)

- **Q1. RPC agents.** Does `pi --mode rpc` load every package in `~/.pi/agent/settings.json` (claude-bridge,
  pi-subagents, pi-mcp-adapter, pi-lens) and route their dialogs over `extension_ui_request`? Memory, first measure (2026-11-06): one idle agent process uses about 340 MB while loading and
  about 170 MB after it settles. Running `pi` sessions on this machine use 40-120 MB. Measure again with a busy
  agent and a long session. This sets the default for the maximum number of live agents. (ADR 0002)
- **Q3. Strata concurrency.** What does `serve/server.py --engine strata` do with a second request while one is
  running: queue it, run it in parallel, or reject it? The slot lock (ADR 0010) is required either way, but the
  error handling differs.
- **Q11. Codex plan windows.** Where do Codex 5-hour and weekly numbers come from in Pi? pi-ai 1.5.0 shows no
  `x-codex-*` headers. Candidates: response headers on the `openai-codex` provider, or Codex session `token_count`
  events. (ADR 0022)

## Later

- **Q5. pi-subagents child runs.** How does pi-spore observe helpers a worker starts through pi-subagents: their
  run files under `~/.pi/agent/pi-subagents/`, or events the extension emits? (ADR 0013)
- **Q13. Agent process limits.** Idle timeout before an agent process stops, and the maximum number of live agent
  processes, given Unity editors also need RAM. Set after Q1.
- **Q14. GitHub workflows.** Some projects have Claude GitHub workflows (for example `claude.yml` and
  `claude-code-review.yml`). They may
  review the same PRs pi-spore watches. Decide whether PR watch ignores their comments or feeds them to the worker.
