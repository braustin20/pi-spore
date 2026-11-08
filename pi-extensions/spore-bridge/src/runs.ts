/**
 * Run tools (R7, ADR 0150): the coordinator of a run starts, revises, and merges lanes and answers their questions;
 * an agent in a lane asks its coordinator. The server checks who may call each route.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { ApprovalAnswer } from "./cards.js";
import { type BridgeClient, type BridgeEnv, QuestionAnswer } from "./client.js";

const LaneAnswer = Type.Object({
  lane: Type.Object({ id: Type.String(), name: Type.String(), state: Type.String() }),
});

const text = (value: string) => [{ type: "text" as const, text: value }];

export function registerRunTools(pi: ExtensionAPI, client: BridgeClient, env: BridgeEnv): void {
  if (env.runRole === "lane") {
    pi.registerTool({
      name: "ask_coordinator",
      label: "Ask the coordinator",
      description:
        "File a question for the coordinator of your run and end your turn. The answer arrives later as a new " +
        "message, maybe after a restart.",
      promptSnippet: "Ask your run's coordinator a question; the answer arrives later as a message",
      promptGuidelines: [
        "Use ask_coordinator when the brief leaves a decision open. Call it alone, as the last tool call of your turn, then stop.",
        "Write the question so you can continue the work from the answer alone.",
      ],
      parameters: Type.Object({
        question: Type.String({
          minLength: 1,
          maxLength: 4_000,
          description: "The question, with the context needed to answer it",
        }),
      }),
      async execute(toolCallId, params, signal) {
        const { question } = await client.call(QuestionAnswer, "coordinator/questions", {
          body: params,
          receipt: toolCallId,
          ...(signal ? { signal } : {}),
        });
        return {
          content: text(
            `The question is with your coordinator (question ${question.id}). Stop now. The answer arrives as a new message.`,
          ),
          details: { questionId: question.id },
          terminate: true,
        };
      },
    });
    return;
  }
  if (env.runRole !== "coordinator") return;

  /** Calls a lane route and says where the lane is. */
  const laneCall = async (
    path: string,
    body: unknown,
    receipt: string,
    signal: AbortSignal | undefined,
    verb: string,
  ) => {
    const { lane } = await client.call(LaneAnswer, path, {
      body,
      receipt,
      ...(signal ? { signal } : {}),
    });
    return { lane, summary: `Lane "${lane.name}" (${lane.id}) ${verb}; it is ${lane.state}.` };
  };

  pi.registerTool({
    name: "start_lane",
    label: "Start lane",
    description:
      "Add a lane to this run. A lane is one piece of the work, built by a pipeline in its own workspace once every " +
      "lane of a lower wave and every lane in dependsOn is merged. The brief is an artifact you wrote in this workspace.",
    promptSnippet: "Start a lane of this run from a brief artifact",
    promptGuidelines: [
      "Write each lane's brief with artifacts_write first, then call start_lane with its path.",
    ],
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 120, description: "Short lane name" }),
      brief: Type.String({ minLength: 1, description: "Artifact path of the brief" }),
      wave: Type.Integer({
        minimum: 1,
        description: "Lanes of wave 2 start after every lane of wave 1 is merged",
      }),
      dependsOn: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), { description: "Ids of lanes to wait for" }),
      ),
      pipeline: Type.Optional(
        Type.String({ minLength: 1, description: "Pipeline id; default: default" }),
      ),
      model: Type.Optional(
        Type.String({
          pattern: "^[^\\s/]+/\\S+$",
          description: "provider/id; a model above the worker default needs the user's approval",
        }),
      ),
    }),
    async execute(toolCallId, params, signal) {
      const { summary, lane } = await laneCall("lanes", params, toolCallId, signal, "was added");
      return { content: text(summary), details: { laneId: lane.id } };
    },
  });

  pi.registerTool({
    name: "revise_lane",
    label: "Revise lane",
    description:
      "Send a passed or failed lane back with a new brief (an artifact path). Its pipeline runs again in the lane's workspace.",
    promptSnippet: "Send a lane back with a new brief",
    parameters: Type.Object({
      laneId: Type.String({ minLength: 1 }),
      brief: Type.String({ minLength: 1, description: "Artifact path of the new brief" }),
    }),
    async execute(toolCallId, params, signal) {
      const { summary, lane } = await laneCall(
        "lanes/revise",
        params,
        toolCallId,
        signal,
        "was sent back",
      );
      return { content: text(summary), details: { laneId: lane.id } };
    },
  });

  pi.registerTool({
    name: "merge_lane",
    label: "Merge lane",
    description:
      "Merge a passed lane into the run's line. pi-spore commits the merge only if the run's gates pass on the merged " +
      "tree. The result arrives later as a message.",
    promptSnippet: "Merge a passed lane into the run line; the result arrives later as a message",
    promptGuidelines: [
      "Read the lane's diff artifact before you call merge_lane. After it, stop and wait for the result message.",
    ],
    parameters: Type.Object({ laneId: Type.String({ minLength: 1 }) }),
    async execute(toolCallId, params, signal) {
      const { summary, lane } = await laneCall(
        "lanes/merge",
        params,
        toolCallId,
        signal,
        "is being merged",
      );
      return {
        content: text(`${summary} The result arrives later as a message.`),
        details: { laneId: lane.id },
      };
    },
  });

  pi.registerTool({
    name: "answer_lane",
    label: "Answer lane",
    description:
      "Answer a question a lane agent asked with ask_coordinator. The answer is delivered to that agent as a message.",
    promptSnippet: "Answer a lane agent's question",
    promptGuidelines: [
      "Answer from the spec. If the spec does not say, ask the user with request_human_input first, then call answer_lane.",
    ],
    parameters: Type.Object({
      questionId: Type.String({ minLength: 1, description: "The question id in the message" }),
      answer: Type.String({ minLength: 1, maxLength: 8_000 }),
    }),
    async execute(toolCallId, params, signal) {
      const { question } = await client.call(QuestionAnswer, "coordinator/answers", {
        body: params,
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return {
        content: text(`The answer to question ${question.id} was sent to the lane agent.`),
        details: { questionId: question.id },
      };
    },
  });

  pi.registerTool({
    name: "open_run_pr",
    label: "Ask to open the run's PR",
    description:
      "Ask the user to open the one PR of this run, then end your turn. Call it only when every lane is merged or " +
      "declined. Nothing is sent to GitHub until the user approves on pi-spore's Home page; they may edit the title " +
      "and body or decline. It never merges the PR. The decision arrives as a new user message.",
    promptSnippet: "Ask the user to open the run's PR once every lane is merged or declined",
    promptGuidelines: ["Call open_run_pr alone, as the last tool call of your turn, then stop."],
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 256, description: "The PR title" }),
      body: Type.String({ maxLength: 65_536, description: "The PR body: what the run built" }),
    }),
    async execute(toolCallId, params, signal) {
      const { approval } = await client.call(ApprovalAnswer, "coordinator/pr", {
        body: params,
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return {
        content: text(
          `The request is on the user's Home page (approval ${approval.id}: ${approval.title}). Stop now. ` +
            "The decision arrives as a new user message.",
        ),
        details: { approvalId: approval.id },
        terminate: true,
      };
    },
  });
}
