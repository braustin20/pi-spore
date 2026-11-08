import { defineInterface } from "@pi-spore/module-api";
import type { AgentDialog } from "@pi-spore/shared";
import type { ComponentType, ReactNode } from "react";

export interface DialogAnswerFields {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** Why a chat waits for the user: an open question, approval, or dialog. */
export type UserWait = "question" | "approval" | "dialog";

/** A React hook that returns the waits of all chats, keyed by chat id. */
export type UseUserWaits = () => ReadonlyMap<string, UserWait>;

/** What the agents web module shares with other pages, so Home shows the same dialog cards as the chat (R5.6). */
export interface AgentsWeb {
  /**
   * Adds (or replaces, by `id`) a component the chat page shows above the composer of an active chat. It gets the chat's id. The attention
   * module uses it for the chat's open questions and approvals.
   */
  addChatPanel(id: string, panel: ComponentType<{ chatId: string }>): void;
  /** Sets the hook that tells which chats wait for the user, for the workspace list. The attention module sets it. */
  setUserWaits(hook: UseUserWaits): void;
  /**
   * Sets the component that renders a link to a Markdown file in a message (`.md`, `.markdown`). It gets the chat's workspace id and the
   * path as written. The artifacts module sets it, to open the file in its viewer. Without one the link stays plain.
   */
  setFileLink(
    component: ComponentType<{ workspaceId: string; path: string; children: ReactNode }>,
  ): void;
  DialogCard: ComponentType<{
    dialog: AgentDialog;
    onAnswer: (answer: DialogAnswerFields) => void;
  }>;
}

export const AgentsWebKey = defineInterface<AgentsWeb>("agents", "web");
