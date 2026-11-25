# 0200. Questions link to artifacts, and a click opens the file over the page

- Status: Accepted
- Date: 2026-11-24
- Requirements: R3.5, R14.2
- Builds on: [0008](0008-questions-up-the-chain.md), [0070](0070-artifacts-per-workspace-and-project.md)

## Context

The orchestrator writes its plan and slice briefs with `artifacts_write`, then asks the user to approve the plan
with `request_human_input`. The user must read the plan before they say yes. Until now they had to find the file in
the Artifacts tab by hand. On a phone that is slow.

## Decision

- **The field.** `request_human_input` and `FileQuestionRequest` take `artifacts`: 1 to 6 items
  `{ scope: "workspace" | "project", path, label? }`, the same scope and relative path as `artifacts_write`. The
  stored `Question` has `artifacts` with `ownerId` added to each item (the workspace id, or its project id), so the
  web can build the file route without a lookup. A question with none has no `artifacts` key.
- **Fail loudly.** The bridge route `POST /api/bridge/questions` checks each file exists with `ArtifactsKey.list`.
  A missing one answers 400 `artifact_not_found` and names the scope and path, and nothing is filed. The check is in
  the bridge, not in attention: the bridge already requires both modules, so attention does not require
  `artifacts`.
- **Storage.** A nullable column `attention_questions.artifacts` (JSON). NULL means none, so old rows load.
  Answered and closed questions keep it.
- **The card.** The question card (Home and the chat panel) shows one **Read &lt;label&gt;** button per file, above
  the prompt, on every step. `label` defaults to the file name.
- **The overlay.** A click opens the file in a `ContentDialog` with `ArtifactView`, through the file route of its
  scope (`/api/artifacts/{workspaces,projects}/:id/file`). The user stays on the question and keeps the draft.
  Escape in the dialog closes only the dialog. No URL state; the Artifacts tab does not change.
- **The seam.** `AttentionWeb.setArtifactLink(component)`, like `AgentsWeb.setFileLink`. The artifacts web module
  sets it (its `requires` gains `attention`). Attention never imports artifacts code. With no component set, the
  card shows each path as plain text.
- **The rule.** The orchestrator rules say to write the plan with `artifacts_write` first and pass it and each brief
  in `artifacts` when it sends the plan.

## Consequences

- The user reads a plan with one click, on a desktop or a phone, and answers on the same card.
- A file deleted or renamed after the question was filed shows the viewer's error in the dialog. The check runs only
  at filing.
- Approvals have no such field yet. A gate that needs one can add it the same way.
