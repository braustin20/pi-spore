# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Spikes (answer with a small experiment before or during the skeleton)

- **Q17. `unity close` without the Pipeline package.** Can `unity close <path>` close an editor whose project has
  no Pipeline package, or does it need `--force` (SIGTERM)? Check on a throwaway project, never on a real one with
  unsaved work. Until then a failed close shows its error and the user closes Unity by hand. (ADR 0028)

## Later

- **Q5. pi-subagents child runs.** How does pi-spore observe helpers a worker starts through pi-subagents: their
  run files under `~/.pi/agent/pi-subagents/`, or events the extension emits? (ADR 0013)
- **Q18. Cards on Home.** Overdue and due-today cards belong in the Home inbox (R15.1), but the attention module
  has no way for other modules to add items. A PR watch that waits for the user belongs there too. Decide the shape
  of that hook (an interface key that modules register item sources with, or a topic Home also reads) when
  attention is next changed. (Kanban, R11; PR watch, R9.2)
