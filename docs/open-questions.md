# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Spikes (answer with a small experiment before or during the skeleton)

- **Q17. `unity close` without the Pipeline package.** Can `unity close <path>` close an editor whose project has
  no Pipeline package, or does it need `--force` (SIGTERM)? Check on a throwaway project, never on a real one with
  unsaved work. Until then a failed close shows its error and the user closes Unity by hand. (ADR 0028)
