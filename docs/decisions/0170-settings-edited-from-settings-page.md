# 0170. Settings are edited from the Settings page

- Status: Accepted
- Date: 2026-11-10
- Requirements: R16.2, R17.1, R17.2, R17.3

## Context

pi-spore reads settings from files and shows each value with its source (R17.1, R17.2). To change one, the user
edits a file by hand. The Settings page should change a setting itself. Each layer of the resolve order needs an
owner for its writes. On 2026-11-10 the user chose where each layer saves.

## Decision

- Global settings save to `~/.pi-spore/settings.json`.
- Project settings save to `<project>/.pi-spore/config.local.toml`. pi-spore never writes `config.toml`, so a
  change never shows up in a commit.
- Workspace settings stay read-only. pi-spore reads them only when it makes a workspace (ADR 0166).
- One change sets one key to a value, or unsets it. Unset removes the key, so the next layer down applies.
- The server checks the whole new file against every declaration before it writes. A bad value answers 422
  `bad_settings` or `bad_project_config`, names the key, and leaves the file as it was. The router keys
  (`router.*`, `tiers`) are checked with the router's own parser.
- The server writes a temp file, then renames it, so a reader never sees half a file.
- pi-spore rewrites `config.local.toml` with smol-toml. Comments and layout in that file are lost.
- Out of scope: the `actions` section, and every other reserved section except the router keys.

## Consequences

- A project setting change stays on this machine. To share it, the user copies it into `config.toml` by hand.
- A user who keeps comments in `config.local.toml` loses them on the first save from the page.
- Writes are one at a time in the server process. An edit by hand during a save can still be lost.
