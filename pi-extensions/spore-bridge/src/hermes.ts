/**
 * `ask_hermes` and `cancel_hermes_ask` (ADR 0202, card Hermes 1.2): hand a question or a task to the Hermes profile
 * `pi-spore`, a remote agent on the user's home server. The tool returns a handoff id at once; pi-spore sends the
 * handoff, follows it, and delivers the result to this chat as a new message.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { StringEnum } from "./cards.js";
import type { BridgeClient, BridgeEnv } from "./client.js";

const HandoffAnswer = Type.Object({
  handoff: Type.Object({ id: Type.String(), state: Type.String() }),
});

const text = (value: string) => [{ type: "text" as const, text: value }];

/**
 * Registers the tools in workspace chats and the planner chat only (ADR 0202 decision 9). Stage chats, lane chats,
 * and side chats never get them, so Hermes is no side channel between lanes (R7.5). The planner chat's allowlist
 * names them; helpers run under a ceiling that leaves them out. The server refuses the rest: a chat that works on a
 * Hermes request, and a Hermes that is off or set up wrong.
 */
export function registerHermesTools(pi: ExtensionAPI, client: BridgeClient, env: BridgeEnv): void {
  if (env.chatKind === "stage" || env.chatKind === "side" || env.runRole === "lane") return;

  pi.registerTool({
    name: "ask_hermes",
    label: "Ask Hermes",
    description:
      "Hand a question or a task to Hermes, a remote agent profile (`pi-spore`) on the user's home server. Hermes is " +
      "not Homelab Maintainer and has none of its memories or chats: give all the context it needs in the text. A " +
      "task may change files in Hermes's container; it is not a sandbox. Hermes asks the user, not you, to approve " +
      "risky steps. The tool returns a handoff id at once; the answer arrives later as a new message.",
    promptSnippet: "Hand a question or a task to the remote Hermes agent; the answer arrives later",
    promptGuidelines: [
      "Use ask_hermes only for work the user wants done by Hermes on the home server. Send only what Hermes needs; never paste secrets.",
      "Do not poll for the answer after ask_hermes; it arrives as a new message. Cancel with cancel_hermes_ask if it is no longer needed.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["question", "task"], {
        description:
          "question: Hermes answers. task: Hermes does something, which may change files",
      }),
      text: Type.String({
        minLength: 1,
        maxLength: 8_000,
        description: "The question or task, with all the context Hermes needs",
      }),
      title: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description: "A short title for the handoff list",
        }),
      ),
    }),
    async execute(toolCallId, params, signal) {
      const { handoff } = await client.call(HandoffAnswer, "hermes/asks", {
        body: {
          kind: params.kind,
          text: params.text,
          ...(params.title !== undefined ? { title: params.title } : {}),
        },
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return {
        content: text(
          `Sent to Hermes as handoff ${handoff.id} (${handoff.state}). The answer arrives as a new message; do not poll.`,
        ),
        details: { handoffId: handoff.id },
      };
    },
  });

  pi.registerTool({
    name: "cancel_hermes_ask",
    label: "Cancel Hermes ask",
    description:
      "Cancel a handoff this chat gave Hermes with ask_hermes. Hermes stops the run; steps it already completed are " +
      "not undone. The end arrives as a new message.",
    promptSnippet: "Cancel an ask_hermes handoff of this chat",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "The handoff id ask_hermes returned" }),
    }),
    async execute(toolCallId, params, signal) {
      const { handoff } = await client.call(
        HandoffAnswer,
        `hermes/asks/${encodeURIComponent(params.id)}/cancel`,
        {
          body: {},
          receipt: toolCallId,
          ...(signal ? { signal } : {}),
        },
      );
      return {
        content: text(
          `Asked Hermes to stop handoff ${handoff.id} (now ${handoff.state}). Steps it completed are not undone.`,
        ),
        details: { handoffId: handoff.id },
      };
    },
  });
}
