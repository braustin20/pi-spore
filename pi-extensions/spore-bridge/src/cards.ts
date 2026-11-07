/**
 * Kanban tools (ADR 0100): agents list, add, change, and ask to start cards of their own project. The server limits
 * every call to that project; a start only files an approval for the user on Home.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import type { BridgeClient } from "./client.js";

/**
 * `{ type: "string", enum: [...] }`, the enum shape every model provider accepts; a union of literals becomes
 * `anyOf`, which some do not. Pi's own StringEnum returns another schema library's type.
 */
function StringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}

const COLUMNS = ["backlog", "ready", "in-progress", "review", "done"] as const;

const Blocker = Type.Object({
  kind: Type.String(),
  id: Type.String(),
  title: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  open: Type.Boolean(),
});

export const CardSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  body: Type.String(),
  labels: Type.Array(Type.String()),
  due: Type.Optional(Type.String()),
  column: Type.String(),
  workspaceId: Type.Optional(Type.String()),
  blockedBy: Type.Array(Blocker),
  blocked: Type.Boolean(),
});
export type CardSchema = Static<typeof CardSchema>;

export const CardAnswer = Type.Object({ card: CardSchema });
export const CardListAnswer = Type.Object({
  cards: Type.Array(CardSchema),
  workspaces: Type.Array(
    Type.Object({ id: Type.String(), name: Type.String(), current: Type.Boolean() }),
  ),
});
export const ApprovalAnswer = Type.Object({
  approval: Type.Object({ id: Type.String(), title: Type.String() }),
});

const text = (value: string) => [{ type: "text" as const, text: value }];

/** One line per card, with what an agent needs to link or start it. */
export function cardLine(card: CardSchema): string {
  const open = card.blockedBy.filter((blocker) => blocker.open);
  return [
    `${card.id}  [${card.column}]  ${card.title}`,
    card.labels.length > 0 ? `labels: ${card.labels.join(", ")}` : "",
    card.due ? `due ${card.due}` : "",
    open.length > 0
      ? `blocked by: ${open.map((blocker) => `${blocker.title ?? blocker.name} (${blocker.id})`).join(", ")}`
      : "",
    card.workspaceId ? `workspace ${card.workspaceId}` : "",
  ]
    .filter((part) => part !== "")
    .join("  ");
}

const Title = Type.String({ minLength: 1, maxLength: 200, description: "Short card title" });
const Body = Type.String({
  maxLength: 50_000,
  description: "Markdown notes: the goal, the steps, and how to check the work",
});
const Labels = Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
  maxItems: 20,
  description: "Labels, such as plan:<short name> for the cards of one plan",
});
const Due = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "A day, YYYY-MM-DD" });
const BlockedBy = Type.Array(Type.String({ minLength: 1 }), {
  maxItems: 50,
  description: "Ids of cards that must be done first",
});

export function registerCardTools(pi: ExtensionAPI, client: BridgeClient): void {
  pi.registerTool({
    name: "kanban_list_cards",
    label: "List cards",
    description:
      "List the kanban cards of this project, with their ids, columns, labels, and blockers, and the project's " +
      "active workspaces (the targets kanban_start_card can use).",
    promptSnippet: "List this project's kanban cards and active workspaces",
    parameters: Type.Object({
      label: Type.Optional(
        Type.String({ minLength: 1, description: "Only cards with this label" }),
      ),
      column: Type.Optional(StringEnum(COLUMNS, { description: "Only cards in this column" })),
    }),
    async execute(_toolCallId, params, signal) {
      const query = new URLSearchParams();
      if (params.label) query.set("label", params.label);
      if (params.column) query.set("column", params.column);
      const { cards, workspaces } = await client.call(CardListAnswer, `cards?${query}`, {
        ...(signal ? { signal } : {}),
      });
      const lines = [
        cards.length === 0 ? "No cards match." : `Cards (${cards.length}):`,
        ...cards.map(cardLine),
        "",
        "Active workspaces of this project:",
        ...workspaces.map(
          (workspace) =>
            `${workspace.id}  ${workspace.name}${workspace.current ? "  (this workspace)" : ""}`,
        ),
      ];
      return { content: text(lines.join("\n")), details: { count: cards.length } };
    },
  });

  pi.registerTool({
    name: "kanban_add_card",
    label: "Add card",
    description:
      "Add a kanban card to this project. It goes to the end of its column (default backlog). The board shows " +
      "that you added it.",
    promptSnippet: "Add a kanban card to this project",
    promptGuidelines: [
      "Use kanban_add_card and kanban_update_card only when the user asks for cards or card changes.",
      "When the user asks to turn a plan with phases into cards, call kanban_add_card once per phase, in order. Give every card the same label plan:<short name>, and set blockedBy of each phase to the id of the phase before it.",
    ],
    parameters: Type.Object({
      title: Title,
      body: Type.Optional(Body),
      labels: Type.Optional(Labels),
      due: Type.Optional(Due),
      column: Type.Optional(StringEnum(COLUMNS, { description: "Default: backlog" })),
      blockedBy: Type.Optional(BlockedBy),
    }),
    async execute(toolCallId, params, signal) {
      const { card } = await client.call(CardAnswer, "cards", {
        body: params,
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return { content: text(`Added card ${cardLine(card)}`), details: { cardId: card.id } };
    },
  });

  pi.registerTool({
    name: "kanban_update_card",
    label: "Change card",
    description:
      "Change a kanban card of this project: the fields given are replaced, blockedBy replaces the whole list, " +
      "column moves the card to the end of that column, and due null clears the day.",
    promptSnippet: "Change or move a kanban card of this project",
    parameters: Type.Object({
      cardId: Type.String({ minLength: 1 }),
      title: Type.Optional(Title),
      body: Type.Optional(Body),
      labels: Type.Optional(Labels),
      due: Type.Optional(Type.Union([Due, Type.Null()])),
      column: Type.Optional(StringEnum(COLUMNS)),
      blockedBy: Type.Optional(BlockedBy),
    }),
    async execute(toolCallId, params, signal) {
      const { cardId, ...fields } = params;
      const { card } = await client.call(CardAnswer, `cards/${encodeURIComponent(cardId)}`, {
        body: fields,
        receipt: toolCallId,
        ...(signal ? { signal } : {}),
      });
      return { content: text(`Changed card ${cardLine(card)}`), details: { cardId: card.id } };
    },
  });

  pi.registerTool({
    name: "kanban_start_card",
    label: "Ask to start card",
    description:
      "Ask the user to start work from a card of this project, then end your turn. Nothing starts until the " +
      "user approves on pi-spore's Home page; they may change the target or decline. The decision arrives as a " +
      "new user message. Target: an active workspace of this project by workspaceId (for related work, see " +
      "kanban_list_cards), or a new workspace without workspaceId, with isolation new (a new worktree or copy, " +
      "the default), existing (an existing branch, given as line), or in-place (the main checkout).",
    promptSnippet: "Ask the user to approve starting work from a card",
    promptGuidelines: [
      "Use kanban_start_card only when the user asks you to start a card. Call it alone, as the last tool call of your turn, then stop.",
    ],
    parameters: Type.Object({
      cardId: Type.String({ minLength: 1 }),
      reason: Type.String({
        minLength: 1,
        maxLength: 4_000,
        description: "Why this card, and why this target; the user reads it on Home",
      }),
      workspaceId: Type.Optional(
        Type.String({ minLength: 1, description: "An active workspace of this project" }),
      ),
      isolation: Type.Optional(
        StringEnum(["new", "existing", "in-place"] as const, {
          description: "For a new workspace only. Default: new",
        }),
      ),
      line: Type.Optional(
        Type.String({ minLength: 1, description: "Branch for isolation existing" }),
      ),
      base: Type.Optional(
        Type.String({ minLength: 1, description: "Branch a new worktree starts from" }),
      ),
    }),
    async execute(toolCallId, params, signal) {
      if (params.workspaceId && (params.isolation || params.line || params.base)) {
        throw new Error(
          "Give either workspaceId (an existing workspace) or isolation, line, and base (a new one), not both",
        );
      }
      const target = params.workspaceId
        ? { kind: "existing", workspaceId: params.workspaceId }
        : {
            kind: "new",
            isolation: params.isolation ?? "new",
            ...(params.line ? { line: params.line } : {}),
            ...(params.base ? { base: params.base } : {}),
          };
      const { approval } = await client.call(
        ApprovalAnswer,
        `cards/${encodeURIComponent(params.cardId)}/start`,
        {
          body: { target, reason: params.reason },
          receipt: toolCallId,
          ...(signal ? { signal } : {}),
        },
      );
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
