import Type, { type Static } from "typebox";

const Cols = Type.Integer({ minimum: 2, maximum: 1000 });
const Rows = Type.Integer({ minimum: 1, maximum: 500 });

export const TerminalStatus = Type.Union([Type.Literal("running"), Type.Literal("exited")]);
export type TerminalStatus = Static<typeof TerminalStatus>;

/** A shell in a PTY in a workspace folder. It lives in the server's memory only (R13.2). */
export const Terminal = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  title: Type.String(),
  /** The program that runs, the user's `$SHELL`. */
  shell: Type.String(),
  cols: Type.Integer(),
  rows: Type.Integer(),
  status: TerminalStatus,
  exitCode: Type.Optional(Type.Integer()),
  signal: Type.Optional(Type.Integer()),
  createdAt: Type.Integer(),
});
export type Terminal = Static<typeof Terminal>;

export const TerminalList = Type.Object({
  terminals: Type.Array(Terminal),
  /** How many terminals may be open at once, across all workspaces. */
  max: Type.Integer(),
});
export type TerminalList = Static<typeof TerminalList>;

export const CreateTerminalRequest = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    cols: Cols,
    rows: Rows,
  },
  { additionalProperties: false },
);
export type CreateTerminalRequest = Static<typeof CreateTerminalRequest>;

/** Largest input frame, in characters. The browser splits longer pastes. */
export const TERMINAL_INPUT_MAX = 8192;

/** What the browser sends on a terminal's socket. */
export const TerminalClientMessage = Type.Union([
  Type.Object(
    { type: Type.Literal("input"), data: Type.String({ maxLength: TERMINAL_INPUT_MAX }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("resize"), cols: Cols, rows: Rows },
    { additionalProperties: false },
  ),
]);
export type TerminalClientMessage = Static<typeof TerminalClientMessage>;

/**
 * What the server sends on a terminal's socket. `snapshot` comes first: the recent scrollback, which replaces
 * whatever the browser shows. Then `output` as it happens, and `exit` once when the shell ends (or at once, after the
 * snapshot, if it already has).
 */
export const TerminalServerMessage = Type.Union([
  Type.Object({ type: Type.Literal("snapshot"), data: Type.String() }),
  Type.Object({ type: Type.Literal("output"), data: Type.String() }),
  Type.Object({
    type: Type.Literal("exit"),
    exitCode: Type.Optional(Type.Integer()),
    signal: Type.Optional(Type.Integer()),
  }),
  Type.Object({ type: Type.Literal("error"), message: Type.String() }),
]);
export type TerminalServerMessage = Static<typeof TerminalServerMessage>;
