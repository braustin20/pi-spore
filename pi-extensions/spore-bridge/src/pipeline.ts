/** The orchestrator chat starts a pipeline run for one slice (ADR 0162). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import type { BridgeClient, BridgeEnv } from "./client.js";

const PipelineRunAnswer = Type.Object({
  run: Type.Object({ id: Type.String(), pipelineId: Type.String(), state: Type.String() }),
});

export function registerPipelineTool(pi: ExtensionAPI, client: BridgeClient, env: BridgeEnv) {
  if (env.chatKind !== "worker" || env.runRole) return;

  pi.registerTool({
    name: "start_pipeline",
    label: "Start pipeline",
    description:
      "Send one slice through this workspace's pipeline. Its worker stage writes the code; reviewers and gates " +
      "check it. The brief is an artifact you wrote in this workspace. One run per workspace at a time. The end " +
      "comes back to this chat as a message.",
    promptSnippet: "Start a pipeline run for one slice from a brief artifact",
    // Pi then runs this message's tool calls one by one, so an artifacts_write before it is done first.
    executionMode: "sequential",
    promptGuidelines: [
      "Write the slice's brief with artifacts_write first, then call start_pipeline with its path. Then stop and wait for the end message; do not poll.",
    ],
    parameters: Type.Object({
      brief: Type.String({ minLength: 1, description: "Artifact path of the brief" }),
      pipeline: Type.Optional(
        Type.String({ minLength: 1, description: "Pipeline id; default: default" }),
      ),
      name: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 80,
          description: "Short name of this slice, such as 'push_line tool'",
        }),
      ),
    }),
    async execute(toolCallId, params, signal) {
      const { run } = await client.call(PipelineRunAnswer, "pipelines", {
        body: params,
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Pipeline run ${run.id} (${run.pipelineId}) started; it is ${run.state}. Stop now. Its end arrives as a new message; do not poll.`,
          },
        ],
        details: { runId: run.id },
        terminate: true,
      };
    },
  });
}
