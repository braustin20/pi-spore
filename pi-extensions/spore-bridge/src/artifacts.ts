/**
 * Artifact tools (ADR 0070): agents list, read, and write the artifacts of their own workspace and its project. The
 * server picks the folder from the agent's token, so a call cannot reach another workspace.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { StringEnum } from "./cards.js";
import type { BridgeClient } from "./client.js";

const Scope = StringEnum(["workspace", "project"], {
  description: "workspace: this workspace only. project: shared by all workspaces of this project",
});
const Path = Type.String({
  minLength: 1,
  description: "Relative path with / separators, such as plans/auth.md",
});

const ArtifactSchema = Type.Object({
  scope: Type.String(),
  path: Type.String(),
  bytes: Type.Number(),
  promotedFrom: Type.Optional(Type.String()),
});
type ArtifactSchema = Static<typeof ArtifactSchema>;

const ArtifactAnswer = Type.Object({ artifact: ArtifactSchema });
const ArtifactListAnswer = Type.Object({
  workspace: Type.Array(ArtifactSchema),
  project: Type.Array(ArtifactSchema),
});
const ArtifactFileAnswer = Type.Object({ artifact: ArtifactSchema, content: Type.String() });

const text = (value: string) => [{ type: "text" as const, text: value }];

function artifactLine(artifact: ArtifactSchema): string {
  return [
    `${artifact.scope}  ${artifact.path}  ${artifact.bytes} bytes`,
    artifact.promotedFrom ? `promoted from workspace ${artifact.promotedFrom}` : "",
  ]
    .filter((part) => part !== "")
    .join("  ");
}

export function registerArtifactTools(pi: ExtensionAPI, client: BridgeClient): void {
  pi.registerTool({
    name: "artifacts_list",
    label: "List artifacts",
    description:
      "List the artifacts of this workspace and of this project: files that live outside the working copy and Git.",
    promptSnippet: "List this workspace's and this project's artifacts",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const { workspace, project } = await client.call(ArtifactListAnswer, "artifacts", {
        ...(signal ? { signal } : {}),
      });
      const all = [...workspace, ...project];
      const lines = all.length === 0 ? ["No artifacts."] : all.map(artifactLine);
      return { content: text(lines.join("\n")), details: { count: all.length } };
    },
  });

  pi.registerTool({
    name: "artifacts_read",
    label: "Read artifact",
    description: "Read a text artifact of this workspace or of this project.",
    promptSnippet: "Read an artifact of this workspace or project",
    parameters: Type.Object({ scope: Scope, path: Path }),
    async execute(_toolCallId, params, signal) {
      const query = new URLSearchParams({ scope: params.scope, path: params.path });
      const { artifact, content } = await client.call(
        ArtifactFileAnswer,
        `artifacts/file?${query}`,
        {
          ...(signal ? { signal } : {}),
        },
      );
      return { content: text(content), details: { path: artifact.path, bytes: artifact.bytes } };
    },
  });

  pi.registerTool({
    name: "artifacts_write",
    label: "Write artifact",
    description:
      "Write a text artifact, or replace the file at that path. Artifacts live outside the working copy and Git. " +
      "Use workspace scope for plans, briefs, reports, verdicts, and test proofs. Use project scope for " +
      "decisions, spikes, and notes that the project's workspaces share. Content is text, Markdown preferred.",
    promptSnippet: "Write an artifact (plan, report, note) outside the working copy",
    promptGuidelines: [
      "Use artifacts_write for plans, reports, and notes that are not part of the code. Keep code in the working copy.",
    ],
    parameters: Type.Object({
      scope: Scope,
      path: Path,
      content: Type.String({ description: "The text of the file, Markdown preferred" }),
    }),
    async execute(toolCallId, params, signal) {
      const { artifact } = await client.call(ArtifactAnswer, "artifacts", {
        body: params,
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return {
        content: text(`Wrote ${artifactLine(artifact)}`),
        details: { scope: artifact.scope, path: artifact.path },
      };
    },
  });
}
