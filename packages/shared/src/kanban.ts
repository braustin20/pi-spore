import Type, { type Static } from "typebox";
import { CreateWorkspaceResponse, Isolation, Workspace, WorkspaceState } from "./workspaces.js";

/** The fixed board columns (R11.2, ADR 0012). */
export const CardColumn = Type.Union([
  Type.Literal("backlog"),
  Type.Literal("ready"),
  Type.Literal("in-progress"),
  Type.Literal("review"),
  Type.Literal("done"),
]);
export type CardColumn = Static<typeof CardColumn>;

/** The columns in board order. */
export const CARD_COLUMNS: readonly CardColumn[] = [
  "backlog",
  "ready",
  "in-progress",
  "review",
  "done",
];

export const COLUMN_TITLES: Readonly<Record<CardColumn, string>> = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In progress",
  review: "Review",
  done: "Done",
};

/** A calendar day, `YYYY-MM-DD`. */
export const DueDate = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

/** What blocks a card, as a request names it. */
export const BlockerRef = Type.Object(
  {
    kind: Type.Union([Type.Literal("card"), Type.Literal("workspace")]),
    id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type BlockerRef = Static<typeof BlockerRef>;

/**
 * What blocks a card, with what the board shows. A blocker is open while its card is not done or its workspace is
 * not archived.
 */
export const CardBlocker = Type.Union([
  Type.Object({
    kind: Type.Literal("card"),
    id: Type.String(),
    title: Type.String(),
    column: CardColumn,
    open: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal("workspace"),
    id: Type.String(),
    name: Type.String(),
    state: WorkspaceState,
    open: Type.Boolean(),
  }),
]);
export type CardBlocker = Static<typeof CardBlocker>;

/** The agent (chat) that made or changed a card through spore-bridge (ADR 0100). */
export const CardAuthor = Type.Object({ agentId: Type.String(), workspaceId: Type.String() });
export type CardAuthor = Static<typeof CardAuthor>;

export const Card = Type.Object({
  id: Type.String(),
  title: Type.String(),
  /** Markdown. */
  body: Type.String(),
  projectId: Type.Optional(Type.String()),
  labels: Type.Array(Type.String()),
  due: Type.Optional(DueDate),
  column: CardColumn,
  /** Order within the column, from 0. */
  position: Type.Integer(),
  /** The workspace started from this card. */
  workspaceId: Type.Optional(Type.String()),
  blockedBy: Type.Array(CardBlocker),
  /** True while any blocker is open. */
  blocked: Type.Boolean(),
  /** Absent when the user made it. */
  createdBy: Type.Optional(CardAuthor),
  /** The agent that changed it last. A change by the user clears it. */
  changedBy: Type.Optional(CardAuthor),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type Card = Static<typeof Card>;

/**
 * Why a card moved. `manual` is the user; the others are automatic moves (ADR 0012). Later modules add their own,
 * such as a passed pipeline or an open PR.
 */
export const CardMove = Type.Object({
  at: Type.Integer(),
  from: Type.Optional(CardColumn),
  to: CardColumn,
  reason: Type.String(),
});
export type CardMove = Static<typeof CardMove>;

export const CardList = Type.Object({ cards: Type.Array(Card) });
export type CardList = Static<typeof CardList>;

export const CardDetail = Type.Object({ card: Card, history: Type.Array(CardMove) });
export type CardDetail = Static<typeof CardDetail>;

const Title = Type.String({ minLength: 1, maxLength: 200 });
const Body = Type.String({ maxLength: 50_000 });
const Labels = Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 });
const Blockers = Type.Array(BlockerRef, { maxItems: 50 });

export const CreateCardRequest = Type.Object(
  {
    title: Title,
    body: Type.Optional(Body),
    projectId: Type.Optional(Type.String({ minLength: 1 })),
    labels: Type.Optional(Labels),
    due: Type.Optional(DueDate),
    /** Default: backlog. The card goes to the end of the column. */
    column: Type.Optional(CardColumn),
    blockedBy: Type.Optional(Blockers),
  },
  { additionalProperties: false },
);
export type CreateCardRequest = Static<typeof CreateCardRequest>;

/** Changes the fields given. `null` clears an optional field. */
export const UpdateCardRequest = Type.Object(
  {
    title: Type.Optional(Title),
    body: Type.Optional(Body),
    projectId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    labels: Type.Optional(Labels),
    due: Type.Optional(Type.Union([DueDate, Type.Null()])),
    blockedBy: Type.Optional(Blockers),
  },
  { additionalProperties: false },
);
export type UpdateCardRequest = Static<typeof UpdateCardRequest>;

export const MoveCardRequest = Type.Object(
  {
    column: CardColumn,
    /** Place in the target column, from 0. Default: the end. */
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type MoveCardRequest = Static<typeof MoveCardRequest>;

/** Where work from a card starts (ADR 0100): a new workspace, or an active workspace of the card's project. */
export const CardStartTarget = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("new"),
      isolation: Isolation,
      line: Type.Optional(Type.String({ minLength: 1 })),
      base: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("existing"), workspaceId: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);
export type CardStartTarget = Static<typeof CardStartTarget>;

/**
 * Starts work from a card (R11.4): a new workspace named after the card, with the fields of `CreateWorkspaceRequest`,
 * or an existing workspace by `workspaceId`. Either way the card's brief goes to the workspace's worker chat.
 */
export const StartCardRequest = Type.Union([
  Type.Object(
    {
      /** Needed when the card has no project; must match it when it has one. */
      projectId: Type.Optional(Type.String({ minLength: 1 })),
      isolation: Isolation,
      line: Type.Optional(Type.String({ minLength: 1 })),
      base: Type.Optional(Type.String({ minLength: 1 })),
      /** The user said yes to starting a blocked card. Without it a blocked card answers 409 `card_blocked`. */
      confirmBlocked: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      /** An active workspace of the card's project. */
      workspaceId: Type.String({ minLength: 1 }),
      confirmBlocked: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);
export type StartCardRequest = Static<typeof StartCardRequest>;

export const StartCardResponse = Type.Object({
  card: Card,
  workspace: Workspace,
  /** Only for a new workspace. */
  created: Type.Optional(CreateWorkspaceResponse),
  /** The worker chat that got the card's brief. */
  chatId: Type.String(),
});
export type StartCardResponse = Static<typeof StartCardResponse>;

/** The subject of a `card-start` approval (ADR 0100). */
export const CardStartSubject = Type.Object(
  { cardId: Type.String({ minLength: 1 }), target: CardStartTarget },
  { additionalProperties: false },
);
export type CardStartSubject = Static<typeof CardStartSubject>;

/** spore-bridge's card tools. Cards and blockers are always of the calling agent's project. */
const CardIds = Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 });

export const BridgeAddCardRequest = Type.Object(
  {
    title: Title,
    body: Type.Optional(Body),
    labels: Type.Optional(Labels),
    due: Type.Optional(DueDate),
    column: Type.Optional(CardColumn),
    /** Card ids. */
    blockedBy: Type.Optional(CardIds),
  },
  { additionalProperties: false },
);
export type BridgeAddCardRequest = Static<typeof BridgeAddCardRequest>;

export const BridgeUpdateCardRequest = Type.Object(
  {
    title: Type.Optional(Title),
    body: Type.Optional(Body),
    labels: Type.Optional(Labels),
    due: Type.Optional(Type.Union([DueDate, Type.Null()])),
    column: Type.Optional(CardColumn),
    /** Card ids; replaces the list. */
    blockedBy: Type.Optional(CardIds),
  },
  { additionalProperties: false },
);
export type BridgeUpdateCardRequest = Static<typeof BridgeUpdateCardRequest>;

export const BridgeStartCardRequest = Type.Object(
  { target: CardStartTarget, reason: Type.String({ minLength: 1, maxLength: 4_000 }) },
  { additionalProperties: false },
);
export type BridgeStartCardRequest = Static<typeof BridgeStartCardRequest>;

/** What `kanban_list_cards` gets: the project's cards, and its active workspaces as start targets. */
export const BridgeCardList = Type.Object({
  cards: Type.Array(Card),
  workspaces: Type.Array(
    Type.Object({ id: Type.String(), name: Type.String(), current: Type.Boolean() }),
  ),
});
export type BridgeCardList = Static<typeof BridgeCardList>;

/** The only event of topic `kanban:board`: every card, on subscribe and after every change. */
export const BoardEvent = Type.Object({ type: Type.Literal("board"), cards: Type.Array(Card) });
export type BoardEvent = Static<typeof BoardEvent>;
