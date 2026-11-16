# 0181. pi-spore sets each role's default model in Pi's settings file

- Status: Accepted; extends [0170](0170-settings-edited-from-settings-page.md), builds on [0013](0013-roles-from-pi-subagents.md) and [0175](0175-planner-model-and-early-picks.md)
- Date: 2026-11-15
- Requirements: R3.1, R3.2, R17.1

## Context

The user wants one place to set the default model of each agent role (orchestrator, planner, coordinator,
worker, reviewer, adversarial-reviewer) and each pi-subagents type (scout, researcher, delegate, oracle, ...).
Today they edit `~/.pi/agent/settings.json` by hand, and a typo in a model id shows only when an agent starts.

ADR 0013 reads role defaults from Pi's file: `subagents.agentOverrides.<role>.model` and `.thinking`.
pi-subagents reads the same keys for the helpers it starts. ADR 0170 lets the Settings page write only
pi-spore's own files. A pi-spore-only layer would not reach the helpers that pi-subagents starts.

The run coordinator had no role of its own. It is the run workspace's orchestrator chat, so it ran on the
`orchestrator` default.

## Decision

- pi-spore writes role models to Pi's file, `<agentDir>/settings.json` (`PI_CODING_AGENT_DIR`, else
  `~/.pi/agent`). It changes only `subagents.agentOverrides.<name>.model`. Every other key and value stays.
  This extends ADR 0170 by one file. It keeps ADR 0013's one place.
- `GET /api/agents/role-models` lists each name with its `model` (or none) and a `kind`: `role` for a pi-spore role,
  `subagent` for the rest. The names are:
  - the pi-spore roles: `orchestrator`, `planner`, `coordinator`, `worker`, `reviewer`, `adversarial-reviewer`;
  - pi-subagents' built-in agents: the `*.md` files in the `agents/` folder of the installed pi-subagents package;
  - the user's agents: `<agentDir>/agents/**/*.md`, without `*.chain.md`;
  - every name already in `agentOverrides`.
  pi-subagents exports no way to list its agents, so pi-spore reads these folders itself. An agent's name is its
  frontmatter `name`, or `<package>.<name>` with a `package` field. Project agents, other packages' agents, and
  `agentScanDirs` are not listed. Their names show once they have an override.
- `PUT /api/agents/role-models/:name` takes `{ model }` or `{ unset: true }`. The model must be in the list of
  `GET /api/agents/models`, else 422 `unknown_model` names it and the file stays as it was. A name not in the list
  answers 404 `unknown_role`. Unset removes `model`, and the name's object when it is then empty, so Pi's own
  default applies.
- The write goes to a temp file, then a rename, one at a time in the server process. Pi parses this file with
  `JSON.parse`. A file that does not parse (comments, for example) answers 409 `pi_settings_not_json` and names the
  file; pi-spore never rewrites it. A `subagents`, `agentOverrides`, or name entry that is not an object answers 409
  `pi_settings_shape`.
- New role `coordinator`: a launch hook can name the role whose defaults an agent uses (`LaunchContext.role`). The
  runs module names `coordinator` for a run's coordinator chat. It runs on `agentOverrides.coordinator` when that
  entry has a model or thinking, else on `orchestrator`, else on Pi's default. This is the planner's rule
  (ADR 0175). The chat row's role stays `orchestrator`.
- Only the user's API token reaches these routes. Agent tokens reach only `/api/bridge/*`, and no agent tool sets a
  role's model. So pi-spore still never changes a role's model without approval (AGENTS.md).

## Consequences

- One change sets the model for pi-spore's agents and for pi-subagents' helpers of that name.
- The next agent of that role starts on the new model. A running agent keeps its model. A chat that already has
  a session file keeps the model its session recorded.
- `agentOverridesByProvider` is not shown or changed. When it sets a name for the parent's provider, it still wins
  over the model set here.
- A `coordinator` or `planner` entry with only `thinking` does not fall back to `orchestrator` for its model.
- pi-spore now depends on pi-subagents' agent folder layout and frontmatter. A change there must be handled in
  `modules/agents/src/role-models.ts`.
- Follow-up, not decided: set the thinking level of each role the same way.
