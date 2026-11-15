/**
 * The pipeline tools (ADR 0162, ADR 0179): the orchestrator chat starts a run for one slice and answers the
 * questions its stages ask, and a stage agent outside a lane asks that chat. The server checks who may call each
 * route.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { type BridgeClient, type BridgeEnv, QuestionAnswer } from "./client.js";

const PipelineRunAnswer = Type.Object({
  run: Type.Object({ id: Type.String(), pipelineId: Type.String(), state: Type.String() }),
});

export function registerPipelineTools(pi: ExtensionAPI, client: BridgeClient, env: BridgeEnv) {
  // A stage agent in a lane asks its coordinator with ask_coordinator instead (R7.5, ADR 0179).
  if (env.chatKind === "stage" && env.runRole !== "lane") {
    pi.registerTool({
      name: "ask_orchestrator",
      label: "Ask the orchestrator",
      description:
        "File a question for the chat that started this pipeline and end your turn. The answer arrives later as a " +
        "new message, maybe after a restart.",
      promptSnippet:
        "Ask the chat that started this pipeline; the answer arrives later as a message",
      promptGuidelines: [
        "Use ask_orchestrator when the brief leaves a decision open. Call it alone, as the last tool call of your turn, then stop.",
        "Write the question so the work can go on from the answer alone.",
      ],
      parameters: Type.Object({
        question: Type.String({
          minLength: 1,
          maxLength: 4_000,
          description: "The question, with the context needed to answer it",
        }),
      }),
      async execute(toolCallId, params, signal) {
        const { question } = await client.call(QuestionAnswer, "stage-questions", {
          body: params,
          receipt: toolCallId,
          ...(signal ? { signal } : {}),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `The question is with the chat that started this pipeline (question ${question.id}). Stop now. The answer arrives as a new message.`,
            },
          ],
          details: { questionId: question.id },
          terminate: true,
        };
      },
    });
    return;
  }
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

  pi.registerTool({
    name: "answer_stage",
    label: "Answer stage",
    description:
      "Answer a question a pipeline stage agent asked with ask_orchestrator. The answer is delivered to that agent " +
      "as a message, and its stage goes on.",
    promptSnippet: "Answer a stage agent's question",
    promptGuidelines: [
      "Answer from your plan. If the plan does not say, ask the user with request_human_input first, then call answer_stage.",
    ],
    parameters: Type.Object({
      questionId: Type.String({ minLength: 1, description: "The question id in the message" }),
      answer: Type.String({ minLength: 1, maxLength: 8_000 }),
    }),
    async execute(toolCallId, params, signal) {
      const { question } = await client.call(QuestionAnswer, "stage-answers", {
        body: params,
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `The answer to question ${question.id} was sent to the stage agent; it goes on with its turn.`,
          },
        ],
        details: { questionId: question.id },
      };
    },
  });
}
