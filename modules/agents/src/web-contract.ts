import { defineInterface } from "@pi-spore/module-api";
import type { AgentDialog } from "@pi-spore/shared";
import type { ComponentType } from "react";

export interface DialogAnswerFields {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** What the agents web module shares with other pages, so Home shows the same dialog cards as the chat (R5.6). */
export interface AgentsWeb {
  /**
   * Adds (or replaces, by `id`) a component the chat page shows above the composer of an active chat. It gets the chat's id. The attention
   * module uses it for the chat's open questions and approvals.
   */
  addChatPanel(id: string, panel: ComponentType<{ chatId: string }>): void;
  DialogCard: ComponentType<{
    dialog: AgentDialog;
    onAnswer: (answer: DialogAnswerFields) => void;
  }>;
}

export const AgentsWebKey = defineInterface<AgentsWeb>("agents", "web");
