# 0160. Agents cannot stop the pi-spore server, and get a dev server instead

- Status: Accepted
- Date: 2026-11-09
- Requirements: R3.1, R12.3, R16.3

## Context

- Agents that work on pi-spore itself start test servers. To stop one, an agent ran
  `pkill -f "packages/server/dist/main.js"`. The real server runs as `node packages/server/dist/main.js`, so the
  command stopped it too, and every chat went down.
- The agent had no safe way to run and stop a server: `run_action` waits for its action to end, so a server action
  never returns.

## Decision

- spore-bridge adds a `tool_call` handler for the `bash` tool. It blocks a command that would stop the server, with
  the reason "This would stop the pi-spore server that runs this chat. Start a test server with run_action dev and
  stop it with stop_action."
- The server passes its pid to agents as `PI_SPORE_SERVER_PID`. spore-bridge reads the server's process group, name,
  and command line once with `ps`. If `ps` fails, it checks the pid and the port only, and warns.
- The guard parses the command into simple commands and checks only `kill`, `pkill`, `killall`, and `fuser -k`:
  - `kill` of the pid, `-<pgid>`, `-1`, or `$PI_SPORE_SERVER_PID`. Signal 0 is not a kill. A `kill` fed by `$(...)` or
    by a pipe into `xargs` is blocked when the feeding command names the port, the pid variable, or a marker.
  - `pkill` and `killall` patterns that match the server's name or command line, are `node`, or contain a marker:
    `dist/main.js`, `pi-spore`, `packages/server`.
  - `fuser -k` on the port or a marker.
- When unsure, the guard allows. A kill of another pid always runs.
- `run_action { name, background: true }` returns the run id and log path at once. `stop_action { runId }` cancels a
  run of the workspace with the tool call id as receipt (R16.3).
- pi-spore's own `[actions.dev]` runs `scripts/dev-server.mjs`. It builds, then starts the server from the worktree
  on a temp `PI_SPORE_HOME` and a free port, without `PI_SPORE_URL`, `PI_SPORE_TOKEN`, or `PI_SPORE_SERVER_PID`.
  Actions inherit the real server's env, so the script sets these on purpose. On SIGTERM it waits for the server,
  then removes the temp home. It needs no shell.
  [ADR 0161](0161-dev-server-for-the-user.md) replaces the temp home with a kept home and a sample project.
- The orchestrator and the stage worker rules say: never stop the pi-spore server; use `run_action dev` with
  `background: true` and `stop_action`.

## Consequences

- The guard checks command text only. A script, `bash -c "..."`, an alias, or another language (`os.kill`) can still
  stop the server. It is a safety net, not a wall.
- The `pi-spore` marker also matches worktree paths under `~/.pi-spore/`, so `pkill -f ~/.pi-spore/worktrees/x/vite`
  is blocked. The agent can kill that process by pid instead.
- spore-bridge needs `PI_SPORE_SERVER_PID`. An agent started by an older server turns its tools off and says why;
  restart the server after an update.
