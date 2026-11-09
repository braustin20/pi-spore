# Open Questions

Each question names where it is used. Settle a question by writing or updating an ADR, then delete it here.

## Later

- **Q18. Cards on Home.** Overdue and due-today cards belong in the Home inbox (R15.1), but the attention module
  has no way for other modules to add items. A PR watch that waits for the user belongs there too. Decide the shape
  of that hook (an interface key that modules register item sources with, or a topic Home also reads) when
  attention is next changed. (Kanban, R11; PR watch, R9.2)
