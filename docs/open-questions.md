# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Spikes (answer with a small experiment before or during the skeleton)

- **Q17. `unity close` without the Pipeline package.** Can `unity close <path>` close an editor whose project has
  no Pipeline package, or does it need `--force` (SIGTERM)? Check on a throwaway project, never on a real one with
  unsaved work. Until then a failed close shows its error and the user closes Unity by hand. (ADR 0028)

## Later

- **Q5. pi-subagents child runs.** How does pi-spore observe helpers a worker starts through pi-subagents: their
  run files under `~/.pi/agent/pi-subagents/`, or events the extension emits? (ADR 0013)
- **Q14. GitHub workflows.** Some projects have Claude GitHub workflows (for example `claude.yml` and
  `claude-code-review.yml`). They may
  review the same PRs pi-spore watches. Decide whether PR watch ignores their comments or feeds them to the worker.
- **Q18. Cards on Home.** Overdue and due-today cards belong in the Home inbox (R15.1), but the attention module
  has no way for other modules to add items. Decide the shape of that hook (an interface key that modules register
  item sources with, or a topic Home also reads) when attention is next changed. (Kanban, R11)
- **Q50. Terminal icon glyphs.** Shell prompts and tools that use Nerd Font icons show boxes, because the page uses
  JetBrains Mono. Add a terminal font setting, or bundle a symbols font? (ADR 0050)
- **Q51. Terminal output flow control.** A shell that writes faster than the browser reads fills the server's
  socket buffer; nothing pauses the PTY yet. Pause it above a buffer size, or drop old output for slow sockets?
  (ADR 0050)
