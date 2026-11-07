import { defineInterface } from "@pi-spore/module-api";
import type { Approval } from "@pi-spore/shared";
import type { ComponentType } from "react";

/** What an approval view gets on Home. `approve` may carry a changed subject, which the server checks again. */
export interface ApprovalViewProps {
  approval: Approval;
  busy: boolean;
  approve: (subject?: unknown) => void;
  decline: (note?: string) => void;
}

/**
 * Lets the module that owns an approval kind show it on Home with its own details and choices (ADR 0100). A kind
 * with no view gets a plain one: its title, the reason, and approve or decline.
 */
export interface AttentionWeb {
  addApprovalView(kind: string, view: ComponentType<ApprovalViewProps>): void;
  /** The optional note for the agent that every approval view offers with Decline. */
  DeclineNote: ComponentType<{ note: string; onChange: (note: string) => void }>;
}

export const AttentionWebKey = defineInterface<AttentionWeb>("attention", "web");
