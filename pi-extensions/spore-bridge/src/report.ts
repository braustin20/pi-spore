/**
 * The `report` tool (R6.7): the only way a pipeline stage agent ends its turn. For a reviewer's REVISE with no
 * blocking finding it also asks the Jev classifier whether another review round is worth it (R6.4, ADR 0015).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings, MAX_PROMPT_CHARS, splitModel, sporeHome } from "@pi-spore/router";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import { StringEnum } from "./cards.js";
import type { BridgeClient, BridgeEnv } from "./client.js";

/**
 * Jev must give this much probability to `stop` before the server may end the review early. The bar is high because
 * an early stop skips a review round; a wrong stop costs more than one extra round (ADR 0015, ADR 0024).
 */
const STOP_THRESHOLD = 0.7;

const QUESTION = "another_round";
const QUESTIONS = {
  [QUESTION]: {
    type: "choice",
    instructions:
      "A reviewer asked for changes. Using `prompt`, the review summary and findings, is another review round worth it?",
    criteria: {
      stop: "The remaining findings are minor; another review round is not worth it",
      continue: "The findings need another review round",
    },
  },
} as const;

// These mirror StageReport in @pi-spore/shared; spore-bridge does not depend on it, and the server checks the body.
const Severity = StringEnum(["blocking", "important", "minor"], {
  description: "blocking: must be fixed before the work can pass",
});
const Finding = Type.Object({
  severity: Severity,
  title: Type.String({ minLength: 1 }),
  detail: Type.Optional(Type.String()),
  file: Type.Optional(Type.String()),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
});
type Finding = Static<typeof Finding>;

const TestProof = Type.Object({
  name: Type.String({ minLength: 1, description: "The test's name" }),
  proof: Type.String({
    minLength: 1,
    description: "Artifact path of the run that shows this test failing before the code",
  }),
});

const ReportParams = Type.Object({
  turn: Type.String({
    minLength: 1,
    description: "The turn id on the `Turn:` line of your prompt",
  }),
  summary: Type.String({ minLength: 1, maxLength: 20_000, description: "What you did or found" }),
  verdict: Type.Optional(
    StringEnum(["approve", "revise"], { description: "Reviewers only: approve or revise" }),
  ),
  findings: Type.Optional(Type.Array(Finding, { description: "Reviewers: what you found" })),
  tests: Type.Optional(
    Type.Array(TestProof, { description: "Worker only: every test you added, with its proof" }),
  ),
});
type ReportParams = Static<typeof ReportParams>;

const ReportAnswer = Type.Object({ turn: Type.Object({ id: Type.String() }) });

const ClassifierResult = Type.Object({
  stopReason: Type.Literal("stop"),
  answers: Type.Object({
    [QUESTION]: Type.Object({
      type: Type.Literal("choice"),
      probabilities: Type.Object({ stop: Type.Number({ minimum: 0, maximum: 1 }) }),
    }),
  }),
});

type EarlyStop = { stop: boolean; probability?: number; error?: string };

const text = (value: string) => [{ type: "text" as const, text: value }];

function classifierPrompt(summary: string, findings: readonly Finding[]): string {
  const lines = findings.map((finding) => {
    const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
    return `- ${finding.severity}: ${finding.title}${where}${finding.detail ? `. ${finding.detail}` : ""}`;
  });
  return `${summary}\n\nFindings:\n${lines.join("\n")}`.slice(0, MAX_PROMPT_CHARS);
}

/** Asks Jev. A failure of any kind is returned as `error` so the server records it and the review goes on. */
async function askJev(
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<EarlyStop> {
  try {
    const { classifier: ref } = await loadSettings(sporeHome());
    const { provider, id } = splitModel(ref);
    const classifier = ctx.modelRegistry.findOfType("classifier", provider, id);
    if (!classifier) throw new Error(`classifier ${ref} is not in the catalog`);
    const result = await ctx.modelRegistry.classify(
      classifier,
      { state: { prompt }, questions: QUESTIONS },
      signal ? { signal } : {},
    );
    if (!Check(ClassifierResult, result)) {
      throw new Error(
        result.stopReason === "stop"
          ? `classifier gave no usable answer to "${QUESTION}"`
          : `classifier failed (${result.stopReason})${result.errorMessage ? `: ${result.errorMessage}` : ""}`,
      );
    }
    const probability = result.answers[QUESTION].probabilities.stop;
    return { stop: probability >= STOP_THRESHOLD, probability };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { stop: false, error: (error as Error).message };
  }
}

export function registerReportTool(pi: ExtensionAPI, client: BridgeClient, env: BridgeEnv): void {
  if (env.chatKind !== "stage") return;
  const reviewer = env.stageRole === "reviewer" || env.stageRole === "adversarial-reviewer";

  pi.registerTool({
    name: "report",
    label: "Report",
    description:
      "Send your report for this turn and end it. Every turn must end with one report call. " +
      "Reviewers give a verdict and findings. The worker lists every new test with the artifact path of its failing run.",
    promptSnippet: "Report the result of this pipeline turn; it ends the turn",
    promptGuidelines: [
      "End every turn by calling report once, alone, as your last tool call. Then stop.",
      "Reviewers: give a verdict (approve or revise) and list each finding with a severity. Mark a finding blocking only if the work must not pass with it.",
      "Worker: list every new test in tests, each with the artifact path of the run that shows it failing before the code.",
    ],
    parameters: ReportParams,
    async execute(toolCallId, params: ReportParams, signal, _onUpdate, ctx) {
      const findings = params.findings ?? [];
      const askForEarlyStop =
        reviewer &&
        params.verdict === "revise" &&
        findings.length > 0 &&
        findings.every((finding) => finding.severity !== "blocking");
      const earlyStop = askForEarlyStop
        ? await askJev(classifierPrompt(params.summary, findings), ctx, signal)
        : undefined;
      const { turn } = await client.call(ReportAnswer, "reports", {
        body: { ...params, ...(earlyStop ? { earlyStop } : {}) },
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return {
        content: text(`Report for turn ${turn.id} received. Stop now.`),
        details: { turn: turn.id },
        terminate: true,
      };
    },
  });
}
