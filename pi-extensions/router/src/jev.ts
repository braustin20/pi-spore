/**
 * The classifier questions of ADR 0024. Each is a choice between a "good" answer (fit for a local model) and a
 * "bad" one. The router reads the probability of the good answer.
 */
export const QUESTIONS = {
  bounded: {
    type: "choice",
    instructions:
      "Is the software engineering work requested in `prompt` bounded: a small, well-scoped change with a clear end?",
    criteria: {
      bounded: "Small and scoped, with a clear end",
      open: "Open-ended, large, or exploratory",
    },
  },
  explicit: {
    type: "choice",
    instructions: "Are the requirements in `prompt` explicit and well defined?",
    criteria: {
      explicit: "Explicit, well-defined requirements",
      vague: "Vague, missing, or left to judgment",
    },
  },
  visual: {
    type: "choice",
    instructions:
      "Is the task in `prompt` visual: judged by looking at the result, such as UI layout, scenes, prefabs, shaders, or art?",
    criteria: {
      nonvisual: "Not visual",
      visual: "Visual",
    },
  },
  straightforward: {
    type: "choice",
    instructions: "Is the code change requested in `prompt` straightforward?",
    criteria: {
      straightforward: "A straightforward change",
      hard: "Subtle design, cross-cutting changes, or hard debugging",
    },
  },
} as const;

export type Question = keyof typeof QUESTIONS;

/** The choice of each question that makes a task fit for a local model. */
export const GOOD: Readonly<Record<Question, string>> = {
  bounded: "bounded",
  explicit: "explicit",
  visual: "nonvisual",
  straightforward: "straightforward",
};

/** Probability of the good answer per question. */
export type JevAnswers = Record<Question, number>;

/** The brief is cut to this many characters for the classifier. */
export const MAX_PROMPT_CHARS = 16_000;

/**
 * Reads the good-answer probabilities from a classifier result. Throws when the result is an error or an answer is
 * missing or malformed, so the router records why and goes to the cloud model.
 */
export function readAnswers(result: unknown): JevAnswers {
  const { stopReason, errorMessage, answers } = (result ?? {}) as {
    stopReason?: unknown;
    errorMessage?: unknown;
    answers?: Record<string, unknown>;
  };
  if (stopReason !== "stop") {
    throw new Error(
      `Classifier failed (${String(stopReason)})${typeof errorMessage === "string" ? `: ${errorMessage}` : ""}`,
    );
  }
  const read = (question: Question): number => {
    const answer = answers?.[question] as
      | { type?: unknown; probabilities?: Record<string, unknown> }
      | undefined;
    const probability = answer?.probabilities?.[GOOD[question]];
    if (
      answer?.type !== "choice" ||
      typeof probability !== "number" ||
      !(probability >= 0 && probability <= 1)
    ) {
      throw new Error(`Classifier gave no usable answer to "${question}"`);
    }
    return probability;
  };
  return {
    bounded: read("bounded"),
    explicit: read("explicit"),
    visual: read("visual"),
    straightforward: read("straightforward"),
  };
}
