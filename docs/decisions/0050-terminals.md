# 0050. Terminals: in-memory PTYs, one socket per terminal, the user's token only

- Status: Accepted
- Date: 2026-11-07
- Requirements: R1.2, R13

## Context

pi-spore replaces Orca, so it needs terminals in workspace folders (ADR 0001). A terminal must survive a page
reload (R13.2). A shell is as powerful as the user, so no agent may open or read one. The event hub at `/api/ws`
only sends events to the browser; a terminal needs input, output, and resize both ways. `node-pty` 1.1.0 ships no
Linux binary, so it compiles with `node-gyp` on install.

## Decision

- The `terminals` module runs each terminal as a `node-pty` PTY with the user's `$SHELL` (no arguments), in the
  workspace folder, with the workspace env of actions (`PI_SPORE_WORKSPACE_ID`, `PI_SPORE_WORKSPACE_PATH`,
  `PI_SPORE_PROJECT_ROOT`), `TERM=xterm-256color`, and without `ORCA_*` and `HERDR_*`. No `$SHELL` is an error
  that names it; there is no fallback shell.
- Terminals live in server memory only, with the last 1 MiB of output (in characters) as scrollback. A reconnect
  gets that scrollback, then live output. They end when the server stops; the UI says so.
- Each terminal has its own WebSocket at `/api/terminals/:id/socket`. Modules add such routes through
  `host.sockets`. Every upgrade passes the same checks as `/api/ws`: loopback Host, loopback Origin, and the user's
  token in `?token=`. Agent tokens never match it. Every message is checked against a TypeBox schema.
- At most 8 terminals are open at once (setting `terminals.maxOpen`). Closing sends SIGHUP, then SIGKILL after 5 s.
  Parking or archiving a workspace closes its terminals first. Server exit sends SIGHUP to every shell.
- The terminal font is a choice in the browser (`localStorage`, like the theme) until the settings module lands.
  The font list is the chosen font, JetBrains Mono, then `Symbols Nerd Font Mono`, so Nerd Font prompt icons show
  when the user has a Nerd Font. pi-spore ships no Nerd Font: its icons come from many sets under many licenses.
- `node-pty`'s install script is approved in `allowScripts` in the root `package.json`, pinned to 1.1.0.

## Consequences

- A reload loses nothing; a server restart loses every terminal and its scrollback.
- `npm ci` needs a C++ toolchain (python3, make, g++) on Linux, and fetches Node headers once.
- A new module socket route gets the guards for free, so it cannot forget them.
- Terminal input and output never reach a log. Only open and close events with ids are logged.
