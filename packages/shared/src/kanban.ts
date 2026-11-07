import Type, { type Static } from "typebox";
import { CreateWorkspaceResponse, Isolation, WorkspaceState } from "./workspaces.js";

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

/** Starts a workspace named after the card (R11.4). The other fields are those of `CreateWorkspaceRequest`. */
export const StartCardRequest = Type.Object(
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
);
export type StartCardRequest = Static<typeof StartCardRequest>;

export const StartCardResponse = Type.Object({ card: Card, created: CreateWorkspaceResponse });
export type StartCardResponse = Static<typeof StartCardResponse>;

/** The only event of topic `kanban:board`: every card, on subscribe and after every change. */
export const BoardEvent = Type.Object({ type: Type.Literal("board"), cards: Type.Array(Card) });
export type BoardEvent = Static<typeof BoardEvent>;
