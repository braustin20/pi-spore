import { type BridgeCaller, defineInterface } from "@pi-spore/module-api";
import type { Approval, FileQuestionRequest, Question } from "@pi-spore/shared";
import type { Static, TSchema } from "typebox";

/** Questions agents file for the user (R3.5, ADR 0008), for the bridge module. */
export interface Questions {
  /** Files an open question from the calling agent. It shows on Home until the user answers it. */
  file(caller: BridgeCaller, request: FileQuestionRequest): Question;
}

export const QuestionsKey = defineInterface<Questions>("attention", "questions");

/** One kind of approval, registered by the module that owns the gate (ADR 0100). */
export interface ApprovalKind<S extends TSchema = TSchema> {
  /** Such as `card-start`. */
  kind: string;
  /** Checks the subject when an approval is filed and when the user changes it on approve. */
  subject: S;
  /**
   * Carries out the approved request with the subject the user approved, which may differ from the filed one.
   * Returns what happened, for the asking agent. A throw leaves the approval open and answers the user with the
   * error.
   */
  approve(subject: Static<S>, approval: Approval): Promise<string>;
  /**
   * Runs for an approve and for a decline, inside the transaction that stores the decision, with the decided
   * approval and its final subject. A throw rolls the decision back, so the approval stays open and the user gets
   * the error. For a gate that must record the decision together with it. Not called for a kind no module handles.
   */
  decided?(subject: Static<S>, approval: Approval, approved: boolean): void;
}

/** Decision gates on Home (ADR 0100). Only the user decides them, through the attention routes. */
export interface Approvals {
  register<S extends TSchema>(kind: ApprovalKind<S>): void;
  /** Files an open approval for the calling agent. The kind must be registered; its schema checks the subject. */
  file<S extends TSchema>(
    caller: BridgeCaller,
    request: { kind: string; title: string; reason: string; subject: Static<S> },
  ): Approval;
}

export const ApprovalsKey = defineInterface<Approvals>("attention", "approvals");
