# pi-spore docs

The map of pi-spore's docs. Start here to find a doc. When you add, rename, or remove a doc, an ADR, or a top-level
section, update this map in the same change.

## Overview

- [vision.md](vision.md): the requirements, numbered R1 to R18, and what is out of scope for v1.
- [design.md](design.md): the visual design: feel, themes, type, shape, layout, components, and accessibility.
- [open-questions.md](open-questions.md): unsettled points, each with where it is used.

## Architecture

[architecture.md](architecture.md) describes how pi-spore meets the vision. Its top-level sections:

- [1. Overview](architecture.md#1-overview): a diagram of the browser, the CLI, the server, and the agents.
- [2. Agent runtime](architecture.md#2-agent-runtime): agents as `pi --mode rpc` processes, spore-bridge, chats,
  helpers, and the agent rules.
- [3. Repo layout](architecture.md#3-repo-layout): the packages and modules of the repo.
- [4. Module contract](architecture.md#4-module-contract): the ServerModule and WebModule types and the host
  interface.
- [5. Domain model](architecture.md#5-domain-model): the entities (project, workspace, agent, run, and more) and
  their key fields.
- [6. Persistence and durability](architecture.md#6-persistence-and-durability): the SQLite store, migrations, and
  durable jobs.
- [7. VCS providers](architecture.md#7-vcs-providers): the `VcsProvider` interface, Git, plain folders, and
  worktrees.
- [8. Pipelines](architecture.md#8-pipelines): declared pipelines, stages, stage agents, gates, and review rounds.
- [9. Runs and lanes](architecture.md#9-runs-and-lanes): coordinator runs, lanes in waves, the integration branch,
  and merges.
- [10. Model routing](architecture.md#10-model-routing): the `spore/auto` router, ladders, the local queue, and
  calibration.
- [11a. Usage module](architecture.md#11a-usage-module): plan usage windows for Claude and Codex.
- [11b. Home and questions (attention module)](architecture.md#11b-home-and-questions-attention-module): Home,
  questions, approvals, and notifications.
- [11c. Terminals](architecture.md#11c-terminals): PTY terminals in workspace folders.
- [11d. Changes](architecture.md#11d-changes): the Changes tab and how it reads a workspace's changes.
- [11e. Pull requests](architecture.md#11e-pull-requests): the `github-pr` module, the PR tab, the PR watch, and
  merges.
- [11f. Artifacts](architecture.md#11f-artifacts): files per workspace and per project, outside Git.
- [11g. Agent graph](architecture.md#11g-agent-graph): the live graph of every working agent.
- [11. Unity module](architecture.md#11-unity-module): Unity detection, the Library copy, the editor lease, and
  test gates.
- [12. Kanban](architecture.md#12-kanban): the board, cards, and how cards move with workspaces and runs.
- [13. Settings](architecture.md#13-settings): settings sources, keys, and the Settings page.
- [14. Data layout](architecture.md#14-data-layout): the files under `~/.pi-spore/`.
- [15. API, events, CLI](architecture.md#15-api-events-cli): REST routes, WebSocket topics, and CLI commands.
- [16. Open questions](architecture.md#16-open-questions): a pointer to open-questions.md.

## Decisions

[0000-template.md](decisions/0000-template.md) is the template for a new ADR.

- [0001](decisions/0001-full-workbench.md): Full workbench with a browser UI that replaces Orca. Accepted.
- [0002](decisions/0002-agent-runtime-pi-rpc.md): Agents run as `pi --mode rpc` processes, not Pi Durable.
  Accepted.
- [0003](decisions/0003-modules.md): Features are in-repo modules with a typed contract. Accepted.
- [0004](decisions/0004-state-in-sqlite.md): Workbench state in SQLite with durable jobs. Accepted.
- [0005](decisions/0005-vcs-providers.md): VCS behind a provider interface. Accepted.
- [0006](decisions/0006-declared-pipelines.md): Declared review pipelines in TOML, user and project. Accepted.
- [0007](decisions/0007-coordinator-runs.md): Coordinator runs over lanes in waves. Accepted.
- [0008](decisions/0008-questions-up-the-chain.md): Questions go up the chain as durable deliveries. Accepted.
- [0009](decisions/0009-model-routing.md): A router virtual model sends bounded tasks to local models. Accepted;
  superseded in part by 0141.
- [0010](decisions/0010-local-model-queue.md): Local models run one job at a time; others wait. Accepted.
- [0011](decisions/0011-unity-support.md): Unity support as a module: copy, editor lease, batch-mode gates.
  Accepted.
- [0012](decisions/0012-kanban.md): Kanban board in the workbench database replaces todos. Accepted.
- [0013](decisions/0013-roles-from-pi-subagents.md): Role defaults come from the pi-subagents setup. Accepted.
- [0014](decisions/0014-lane-model-approval.md): Lane models auto-approve unless the coordinator upgrades.
  Accepted.
- [0015](decisions/0015-review-rounds.md): Fixed review limits plus an early-stop Jev check. Accepted.
- [0016](decisions/0016-fail-first-proof.md): Fail-first proof is a recorded artifact the reviewer checks.
  Accepted; changed by 0199.
- [0017](decisions/0017-integration-branch.md): One integration branch per run. Accepted.
- [0018](decisions/0018-worktree-copy-list.md): Gitignored files reach new worktrees through a declared copy list.
  Accepted.
- [0019](decisions/0019-v1-scope.md): v1 scope. Accepted.
- [0020](decisions/0020-name-and-layout.md): Name and data layout. Accepted.
- [0021](decisions/0021-tooling.md): Tooling: Node 26 via .nvmrc and npm scripts, no mise. Accepted.
- [0022](decisions/0022-usage-tracking.md): Track subscription usage and use it in routing. Accepted; Codex
  polling in 0153.
- [0023](decisions/0023-model-tiers.md): Models are ranked by an editable tier list. Accepted; superseded in part
  by 0141 and 0152.
- [0024](decisions/0024-routing-thresholds.md): Starting router thresholds and spill to Codex. Accepted;
  superseded in part by 0141.
- [0025](decisions/0025-agents-without-pi-lens.md): pi-spore agents run without pi-lens and get a `check` tool.
  Accepted.
- [0026](decisions/0026-agent-process-limits.md): Agent process limits. Accepted.
- [0027](decisions/0027-actions.md): Actions: argv commands, setup and teardown hooks, a queue for exclusive runs.
  Accepted.
- [0028](decisions/0028-unity-editor-detection.md): Finding open Unity editors: status, processes, and lock files.
  Accepted.
- [0029](decisions/0029-web-ui-stack.md): Web UI: one shared `@pi-spore/ui` package with Tailwind, Radix, and
  shadcn-style components. Accepted.
- [0030](decisions/0030-chats-per-workspace.md): One writing agent per workspace, fresh chats, and read-only side
  chats. Accepted.
- [0031](decisions/0031-agent-rules-from-spore-bridge.md): spore-bridge replaces the global AGENTS.md in agents
  with pi-spore's rules. Accepted.
- [0032](decisions/0032-agent-tokens-and-bridge-routes.md): Agent tokens, bridge routes, and receipts through
  idempotency keys. Accepted.
- [0033](decisions/0033-side-chat-tools-and-closed-questions.md): Side chat tools, and questions of older worker
  chats. Accepted.
- [0034](decisions/0034-pi-subagents-child-runs.md): pi-subagents helpers are child runs of their worker.
  Accepted.
- [0040](decisions/0040-card-moves-on-workspace-state.md): Cards move on workspace state changes; any archive means
  Done. Accepted.
- [0050](decisions/0050-terminals.md): Terminals: in-memory PTYs, one socket per terminal, the user's token only.
  Accepted.
- [0060](decisions/0060-images-in-the-chat.md): Images in the chat: sent with prompts, shown by reference, linked
  files from the workspace. Accepted.
- [0061](decisions/0061-remote-images-load-on-click.md): Remote images in the chat load only on a click. Accepted.
- [0070](decisions/0070-artifacts-per-workspace-and-project.md): Artifacts per workspace and per project, outside
  Git. Accepted.
- [0090](decisions/0090-changes-and-pull-requests.md): Changes and pull requests: two modules on provider
  capabilities. Accepted.
- [0100](decisions/0100-agent-cards-and-approvals.md): Agents make and start cards; starts by an agent need an
  approval on Home. Accepted.
- [0110](decisions/0110-closing-chats.md): Closing a chat. Accepted.
- [0120](decisions/0120-orchestrator-chat-and-card-models.md): The workspace chat is an orchestrator; cards choose
  its model; workers are subagents on `spore/auto`. Accepted; superseded in part by 0141, 0162, and 0175; extended
  by 0189.
- [0121](decisions/0121-retention.md): Delete the data of finished work after a retention time. Accepted.
- [0130](decisions/0130-merge-on-the-users-word.md): An agent merges a PR only on the user's word. Accepted.
- [0140](decisions/0140-pipeline-stage-agents.md): Pipeline stages run on stage agents; Jev answers inside the
  report tool. Accepted; superseded in part by 0152 and 0169; changed in part by 0198.
- [0141](decisions/0141-router-ladders.md): The router picks a rung on a ladder of cloud plans. Accepted.
- [0142](decisions/0142-merge-button.md): pi-spore merges a PR only when the user clicks Merge and confirms.
  Accepted; superseded in part by 0164.
- [0143](decisions/0143-phone-over-tailscale-serve.md): A phone reaches pi-spore through `tailscale serve`, checked
  by Tailscale login. Accepted.
- [0144](decisions/0144-routing-calibration.md): Calibrate the router's local choice from recorded outcomes.
  Accepted; changed by 0173.
- [0150](decisions/0150-run-worktree-and-green-merges.md): The coordinator works in the run's worktree; a merge
  commits only after its gates pass. Accepted; coordinator card tools in 0154.
- [0151](decisions/0151-run-cancel-handover-and-pr-approval.md): A run can be cancelled, follows the active chat,
  and opens its PR on the user's approval. Accepted; changed by 0157, 0165, and 0183.
- [0152](decisions/0152-equal-tier-reviews.md): A cloud reviewer may sit on the worker's own tier. Accepted.
- [0153](decisions/0153-poll-codex-usage.md): Codex usage is polled with the Codex CLI login. Accepted.
- [0154](decisions/0154-coordinator-adds-cards.md): A run's coordinator adds follow-up cards, but never changes or
  starts them. Accepted.
- [0155](decisions/0155-modules-add-home-items.md): Modules add items to Home through sources. Accepted.
- [0156](decisions/0156-unity-test-gates.md): Unity test gates run in batch mode behind the editor lease, and close
  falls back to `--force`. Accepted.
- [0157](decisions/0157-finished-run-follows-the-active-chat.md): A finished run follows the active chat too.
  Accepted; changed by 0165.
- [0158](decisions/0158-revise-lane-is-a-fix-pass.md): revise_lane is a short fix pass. Accepted.
- [0159](decisions/0159-phone-layout.md): A phone layout below 768 px. Accepted; changed in part by 0196.
- [0160](decisions/0160-guard-the-server-from-agents.md): Agents cannot stop the pi-spore server, and get a dev
  server instead. Accepted.
- [0161](decisions/0161-dev-server-for-the-user.md): The dev server keeps its home and has a sample project.
  Accepted.
- [0162](decisions/0162-orchestrator-starts-pipeline-runs.md): The orchestrator sends each slice through the
  workspace's pipeline. Accepted.
- [0163](decisions/0163-card-work-ends-with-a-pr-by-approval.md): Card work ends with a PR, opened on the user's
  approval. Accepted.
- [0164](decisions/0164-merge-when-checks-pass.md): "Open and merge when checks pass" on the workspace PR approval.
  Accepted.
- [0165](decisions/0165-finished-run-pushes-each-merge.md): A merge into a finished run is pushed to its open PR.
  Accepted.
- [0166](decisions/0166-settings-overrides-at-creation.md): A workspace or run gets its settings override when it
  is made. Accepted.
- [0167](decisions/0167-browser-permission-is-the-notification-switch.md): The browser permission is the only
  desktop notification switch. Accepted.
- [0168](decisions/0168-subagent-nesting-limit.md): The nesting limit is the pi-subagents depth, set by pi-spore.
  Accepted.
- [0169](decisions/0169-remind-a-stage-agent-once-then-block.md): Remind a stage agent once when it ends a turn
  without a report, then block. Accepted; changed in part by 0198.
- [0170](decisions/0170-settings-edited-from-settings-page.md): Settings are edited from the Settings page.
  Accepted.
- [0171](decisions/0171-built-in-themes-from-open-palettes.md): Built-in themes may use open palettes from other
  projects. Accepted.
- [0172](decisions/0172-playwright-for-screenshots-only.md): Playwright is a dev tool for screenshots only.
  Accepted.
- [0173](decisions/0173-explore-visual-tasks.md): Explore also sends visual pipeline worker tasks local. Accepted.
- [0174](decisions/0174-project-planner-chat.md): Each project has a planner chat that reads and adds cards.
  Accepted; superseded in part by 0175 and 0194.
- [0175](decisions/0175-planner-model-and-early-picks.md): The planner falls back to the orchestrator model, and a
  pick before the first message is kept. Accepted.
- [0176](decisions/0176-live-agent-graph.md): The workspaces landing page is a live graph of all agents. Accepted;
  extended by 0188.
- [0177](decisions/0177-unity-worktree-library-drops-bee.md): A Unity worktree gets a copied Library without
  `Library/Bee`. Accepted.
- [0178](decisions/0178-parallel-reviews-and-early-gates.md): Read-only stages of a pipeline run together in a
  parallel group. Proposed.
- [0179](decisions/0179-stage-agents-ask-the-asking-chat.md): A stage agent asks the chat that started its
  pipeline, and the stage waits for the answer. Accepted.
- [0180](decisions/0180-lanes-name-their-card.md): A lane names its card, and pi-spore moves the card with the run.
  Accepted.
- [0181](decisions/0181-role-models-in-pi-settings.md): pi-spore sets each role's default model in Pi's settings
  file. Accepted.
- [0182](decisions/0182-revise-lane-moves-a-lane-to-a-new-model.md): revise_lane can move a lane to a new model.
  Accepted.
- [0183](decisions/0183-decline-a-lane.md): The coordinator or the user declines a lane that will not merge.
  Accepted.
- [0184](decisions/0184-systemd-user-service.md): pi-spore runs as a systemd user service. Accepted; amended by
  0191.
- [0185](decisions/0185-the-phone-document-never-scrolls.md): The phone document never scrolls. Accepted.
- [0186](decisions/0186-changed-file-content.md): One side of a changed file, and images in the Changes tab.
  Accepted.
- [0187](decisions/0187-pause-and-resume-a-pipeline-run.md): Pause and resume a pipeline run. Accepted.
- [0188](decisions/0188-agent-graph-step-outcome.md): An agent graph step says how it ended, or why it waits.
  Accepted.
- [0189](decisions/0189-workspace-chat-starts-with-subagent-active.md): A workspace chat starts with `subagent`
  active. Accepted.
- [0190](decisions/0190-phone-top-rows-hide-only-with-the-keyboard.md): Phone top rows hide only while the keyboard
  is open. Accepted.
- [0191](decisions/0191-service-starts-with-the-graphical-session.md): The service starts with the graphical
  session. Accepted.
- [0192](decisions/0192-phone-short-viewport-heals-by-display-flip.md): A short phone viewport heals by a display
  flip on the root. Accepted.
- [0193](decisions/0193-project-wiki-skill-and-docs-rule.md): pi-spore ships a project-wiki skill and a docs rule
  to every agent. Accepted.
- [0194](decisions/0194-read-only-helpers-for-planner-and-coordinator.md): The planner and the coordinator start
  read-only helpers with `start_helper`. Accepted. Renumbered from 0176.
- [0195](decisions/0195-uncommitted-work-never-passes.md): Uncommitted work never passes a pipeline, and an empty
  lane is not merged. Accepted. Renumbered from 0186.
- [0196](decisions/0196-phone-web-push.md): Phone notifications through Web Push and a service worker. Accepted.
  Renumbered from 0187.
- [0197](decisions/0197-auto-archive-on-merge.md): Archive a workspace when its PR merges, on by default, never
  forced. Accepted.
- [0198](decisions/0198-retry-continues-the-same-stage-agent.md): Retry continues the same stage agent; Fresh agent
  replaces it. Accepted.
- [0199](decisions/0199-proof-by-breaking-the-code.md): A test's proof may come from code broken on purpose; the
  brief suggests the tests. Accepted.

## Spikes

- [pi-lens-value.md](spikes/pi-lens-value.md): is pi-lens worth its memory cost for pi-spore agents? (ADR 0025)
- [q1-rpc-agents.md](spikes/q1-rpc-agents.md): does `pi --mode rpc` load the whole Pi setup, do dialogs reach the
  client, and how much memory does an agent use? (ADR 0002)
- [q3-strata-concurrency.md](spikes/q3-strata-concurrency.md): what Strata does with a second request while one
  runs. (ADR 0010)
- [q5-subagent-child-runs.md](spikes/q5-subagent-child-runs.md): how pi-spore sees the helpers a worker starts
  through pi-subagents. (ADR 0034)
- [q11-codex-plan-windows.md](spikes/q11-codex-plan-windows.md): where Codex 5-hour and weekly usage numbers come
  from in Pi. (ADR 0022, ADR 0024)
- [q17-unity-close.md](spikes/q17-unity-close.md): whether `unity close` works without the Pipeline package, or
  needs `--force`. (ADR 0156)
- [readonly-helpers.md](spikes/readonly-helpers.md): how the planner and the coordinator start `scout` and
  `researcher` without the raw `subagent` tool. (ADR 0194)
