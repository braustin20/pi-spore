# 0174. Each project has a planner chat that reads and adds cards

- Status: Accepted
- Date: 2026-11-11
- Requirements: R3.9, R11 (kanban)

## Context

The user keeps a chat open in the main checkout to brainstorm features and turn them into cards. They close it
often, to get a fresh context. That chat is the main checkout workspace's orchestrator chat. It has `bash`,
`edit`, `write`, the pipeline, and actions. When the user forgets to say "make a card", it runs tests, edits files
on the main checkout, or switches its branch.

Side chats are already read-only through their tool list, not their prompt (ADR 0033,
`SIDE_CHAT_TOOLS` in `modules/agents/src/launch.ts`). They have no kanban tools, so they cannot add cards. They
also belong to a workspace, and planning is about a whole project.

## Decision

- Each project gets one **planner chat** ("Plan"), shown first under the project in the workspace list. Its page
  has the chat only: no Details column, so no Pipeline, Actions, Runs, Changes, or PR panels.
- It reads the project's main checkout folder. It never changes it.
- Its tools are an allowlist, like a side chat (`PLANNER_CHAT_TOOLS`):
  `read,grep,find,ls,request_human_input,artifacts_list,artifacts_read,kanban_list_cards,kanban_add_card,kanban_update_card,web_search,fetch_content,get_search_content`
  with `--exclude-tools 'mcp__*'`. No `bash`, `edit`, `write`, `artifacts_write`, `check`, `run_action`,
  `start_pipeline`, `open_pr`, `kanban_start_card`, or `subagent`. A launch hook that gives a planner chat tools
  fails its launch, so nothing widens the list.
- `subagent` is left out because it can start a writing `worker`. The planner reads the code itself.
- `web_search`, `fetch_content`, and `get_search_content` are tools of the `pi-web-access` Pi extension
  (`pi.registerTool`), not `mcp__*` tools, so the allowlist can name them.
- Its bridge token is read-only, with one exception: it may add cards and update a card's title, body, labels,
  blockers, due date, and model. It may move a card only between `backlog` and `ready`: never into or out of
  `in-progress`, `review`, or `done`. It may not start a card. A call outside that answers 403 `read_only_chat`.
- Cards are its only output. It writes nothing else, not even artifacts. A note that is lost on close is lost
  work, so notes go in the card body.
- spore-bridge gives it planner rules (`PI_SPORE_CHAT_KIND=planner`, `PLANNER_RULES`):
  - List the cards before adding one. Update a card instead of adding a duplicate.
  - Each card stands alone, because the planner's context is thrown away: the goal, why, the files to start
    reading, the requirements or ADRs it touches, and how to check the work.
  - A plan with phases is one card per phase, linked with `blockedBy`, with one shared `plan:<name>` label.
  - Do not ask to start work. When a fact needs a run, a test, or a spike, add a card for it.
- The user closes the planner chat and opens a fresh one with the same "+" and "x" as other chats. The "+" offers
  only New chat; there are no side chats. Old planner chats follow the retention rules of closed chats (ADR 0110,
  ADR 0121).
- Its model is `subagents.agentOverrides.planner` (model, thinking) when set, else Pi's default, as ADR 0120 does
  for `orchestrator`.

### Data model: a hidden planner workspace

A chat row belongs to a workspace (`agents_agents.workspace_id`). The planner lives in a **planner workspace**: one
row in `workspaces_workspaces` per project with `planner = 1` (a unique partial index), isolation `in-place`, the
project's path, and the name "Plan". `POST /api/workspaces/planner { projectId }` finds it or makes it on the first
click. Its chats are normal workspace chats with kind `worker` and role `planner`. The manager reads the role and
launches them read-only.

The other option was a nullable `workspace_id` plus a `project_id` on chats. The session folder, the bridge token,
launch hooks, usage, changes, and about forty queries assume a workspace, so it would change about fifteen files.
The planner workspace keeps every one of them as it is. Only the places that offer a workspace to the user filter
it: the workspace list (it shows as "Plan"), the kanban start and blocker pickers, `kanban_list_cards`, and card
start (409 `planner_workspace`). Rename, park, resume, and archive refuse it (409 `planner_workspace`), and it does
not block removing its project.

## Consequences

- The main checkout's orchestrator chat stays for real work. The planner can never change files or branches,
  whatever the prompt says.
- The planner cannot run `git log`, tests, or scouts. Planning rarely needs them. A read-only git history tool can
  come later if the user misses it.
- New tool names in spore-bridge stay off in the planner until they are added to its list.
- When a project is removed, its planner workspace row stays behind, like its cards. Nothing lists or opens it,
  because it has no project.
