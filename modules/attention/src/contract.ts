import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type { FileQuestionRequest, Question } from "@pi-spore/shared";

/** Questions agents file for the user (R3.5, ADR 0008), for the bridge module. */
export interface Questions {
  /** Files an open question from the calling agent. It shows on Home until the user answers it. */
  file(caller: BridgeCaller, request: FileQuestionRequest): Question;
}

export const QuestionsKey = defineInterface<Questions>("attention", "questions");
