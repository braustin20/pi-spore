# 0184. pi-spore runs as a systemd user service

- Status: Accepted
- Date: 2026-11-15
- Requirements: R1.1, R1.2, R1.6

## Context

To run pi-spore, the user had to `cd` to the repo, `nvm use`, `npm start`, and keep that terminal tab open. Agents
work all day. Closing the tab stopped the server and every agent turn. A rebuild meant the same steps again, and a
restart in the middle of a turn lost that turn.

## Decision

1. **The CLI manages the server.** `pi-spore start [--open]` runs it in the foreground. `pi-spore service install`
   writes `~/.config/systemd/user/pi-spore.service` (under `XDG_CONFIG_HOME` when set), runs
   `systemctl --user daemon-reload`, then `systemctl --user enable --now pi-spore`. `service uninstall`, `open`,
   `restart`, `logs [-f]`, and `rebuild [--install]` do the rest. Linux with systemd only for `service`, `restart`,
   and `logs`. `start`, `open`, and the build part of `rebuild` work anywhere.
2. **The unit holds absolute paths.** systemd does not load nvm or the user's shell files. So:
   - `ExecStart` is the absolute path of the Node that runs the CLI (`process.execPath`), then
     `<repo>/packages/server/dist/main.js`. Install fails if that Node's major version is not the one in `.nvmrc`,
     and names the Node it found.
   - `Environment=PATH` is the folder of that Node, the folder of `pi` (install fails if `pi` is not on the shell's
     PATH), the folders of `git`, `gh`, and `unity` when found, then `/usr/local/bin:/usr/bin:/bin`. Agents need
     these programs.
   - `PI_SPORE_HOME` and `PI_SPORE_PORT` are copied when set.
   - `EnvironmentFile=-%h/.config/pi-spore/service.env` is optional. The user puts there the variables their shell
     sets, such as API keys. pi-spore never reads or writes that file.
   - A path with whitespace, `"`, `\`, `$`, or `%` is refused, because systemd would split or expand it.
   - The repo folder comes from the CLI's own file (`import.meta.url`), not from the current folder.
   - `Restart=on-failure`, `RestartSec=2`, `WantedBy=default.target`.
3. **The user sees the unit first.** Install prints the unit and asks y/N; `--yes` skips the question. Install
   refuses while a foreground server answers, since that server holds the lock and the service could not start.
4. **`rebuild` builds first, then asks before it restarts.** It runs `npm run build` while the server keeps running.
   A failed build stops there and the server is not touched. `npm ci` runs only with `--install`, because it deletes
   `node_modules` under the running server. npm comes from the folder of the unit's Node, with that folder first on
   PATH, so the build uses the same Node as the service.
5. **pi-spore never restarts itself while agents are busy unless the user says yes.** `restart` and `rebuild` read
   `GET /api/agents`. When a chat is `busy` or `starting`, or has helpers running, they list those agents and ask
   y/N. A restart stops their turns. When the server does not answer, nothing runs, so they restart without asking.
6. **Every program runs with argv.** `systemctl`, `journalctl`, `xdg-open`, `npm`, and `node` run through an injected
   runner with no shell. Tests fake it; they never touch real systemd.

## Consequences

- Closing a terminal does not stop pi-spore. A user service still stops at logout unless the user runs
  `loginctl enable-linger` once. pi-spore does not run that for them.
- A new Node version means `pi-spore service install` again, so the unit points at the new Node.
- `npm start` still works for a plain foreground run.
- Variables from the shell's rc files do not reach agents of the service unless the user copies them to
  `service.env`.
