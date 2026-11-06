# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Spikes (answer with a small experiment before or during the skeleton)

- **Q11. Codex plan windows.** Where do Codex 5-hour and weekly numbers come from in Pi? pi-ai 1.5.0 shows no
  `x-codex-*` headers. Candidates: response headers on the `openai-codex` provider, or Codex session `token_count`
  events. (ADR 0022)

## Later

- **Q16. AGENTS.md for agents inside pi-spore.** The user's global `~/.pi/agent/AGENTS.md` describes delegation
  through Orca and pi-subagents. Agents running in pi-spore will ask their coordinator or the user through
  pi-spore's tools instead. Decide which rules pi-spore agents get (a pi-spore section, or a role prompt that
  overrides the global rules) when spore-bridge lands. Do not change the user's global file without asking.

- **Q5. pi-subagents child runs.** How does pi-spore observe helpers a worker starts through pi-subagents: their
  run files under `~/.pi/agent/pi-subagents/`, or events the extension emits? (ADR 0013)
- **Q14. GitHub workflows.** Some projects have Claude GitHub workflows (for example `claude.yml` and
  `claude-code-review.yml`). They may
  review the same PRs pi-spore watches. Decide whether PR watch ignores their comments or feeds them to the worker.
