import { AgentsKey } from "@pi-spore/mod-agents/server";
import { ApprovalsKey } from "@pi-spore/mod-attention/server";
import { ProjectsKey } from "@pi-spore/mod-projects/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type ServerModule } from "@pi-spore/module-api";
import {
  type BlockerRef,
  type BoardEvent,
  CARD_COLUMNS,
  type Card,
  type CardAuthor,
  type CardBlocker,
  type CardColumn,
  type CardDetail,
  type CardMove,
  CardStartSubject,
  type CardStartTarget,
  COLUMN_TITLES,
  CreateCardRequest,
  MoveCardRequest,
  parseJsonBody,
  StartCardRequest,
  type StartCardResponse,
  UpdateCardRequest,
  type Workspace,
} from "@pi-spore/shared";
import { type Cards, CardsKey } from "./contract.js";

export * from "./contract.js";

const BOARD_TOPIC = "kanban:board";

const MIGRATIONS = [
  `CREATE TABLE kanban_cards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    project_id TEXT,
    labels TEXT NOT NULL,
    due TEXT,
    column_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    workspace_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX kanban_cards_by_column ON kanban_cards (column_id, position)",
  "CREATE INDEX kanban_cards_by_workspace ON kanban_cards (workspace_id)",
  `CREATE TABLE kanban_links (
    card_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (card_id, kind, target_id)
  )`,
  `CREATE TABLE kanban_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    from_column TEXT,
    to_column TEXT NOT NULL,
    reason TEXT NOT NULL
  )`,
  "CREATE INDEX kanban_events_by_card ON kanban_events (card_id, id)",
  // ADR 0100: the agent that made a card, and the one that changed it last. JSON CardAuthor, NULL for the user.
  "ALTER TABLE kanban_cards ADD COLUMN created_by TEXT",
  "ALTER TABLE kanban_cards ADD COLUMN changed_by TEXT",
];

/** The approval kind of `kanban_start_card` (ADR 0100). */
export const CARD_START = "card-start";

interface CardRow {
  id: string;
  title: string;
  body: string;
  project_id: string | null;
  labels: string;
  due: string | null;
  column_id: CardColumn;
  position: number;
  workspace_id: string | null;
  created_by: string | null;
  changed_by: string | null;
  created_at: number;
  updated_at: number;
}

interface LinkRow {
  card_id: string;
  kind: BlockerRef["kind"];
  target_id: string;
}

interface EventRow {
  at: number;
  from_column: CardColumn | null;
  to_column: CardColumn;
  reason: string;
}

/** Trimmed, without blanks and repeats, in the order given. */
function cleanLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter((label) => label !== ""))];
}

/** Labels are stored as a JSON array written by this module; anything else is a broken database. */
function readLabels(row: CardRow): string[] {
  try {
    return JSON.parse(row.labels) as string[];
  } catch {
    throw new Error(`Card ${row.id} has broken labels in kanban_cards: ${row.labels}`);
  }
}

/** Authors are stored as JSON written by this module; anything else is a broken database. */
function readAuthor(row: CardRow, value: string): CardAuthor {
  try {
    return JSON.parse(value) as CardAuthor;
  } catch {
    throw new Error(`Card ${row.id} has a broken author in kanban_cards: ${value}`);
  }
}

/** One line per blocker, with whether it still blocks. */
function blockerLine(blocker: CardBlocker): string {
  return blocker.kind === "card"
    ? `- card "${blocker.title}" (${blocker.id}), ${COLUMN_TITLES[blocker.column]}${blocker.open ? ", still open" : ""}`
    : `- workspace "${blocker.name}" (${blocker.id}), ${blocker.state}${blocker.open ? ", still open" : ""}`;
}

/**
 * The message a worker chat gets when work from a card starts in its workspace (ADR 0100). It carries the whole card,
 * so the agent can start from it alone.
 */
export function cardBrief(card: Card, origin: string): string {
  return [
    `Work on this card from the pi-spore board. ${origin}`,
    "",
    `Card: ${card.title} (card ${card.id})`,
    ...(card.labels.length > 0 ? [`Labels: ${card.labels.join(", ")}`] : []),
    ...(card.due ? [`Due: ${card.due}`] : []),
    ...(card.blockedBy.length > 0 ? ["Blocked by:", ...card.blockedBy.map(blockerLine)] : []),
    "",
    card.body.trim() === "" ? "The card has no notes." : card.body.trim(),
  ].join("\n");
}

/** The schema checks the shape; this checks the day exists. */
function checkDue(due: string): string {
  const date = new Date(`${due}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== due) {
    throw new ApiError(400, "bad_due", `"${due}" is not a calendar day (YYYY-MM-DD)`);
  }
  return due;
}

export const kanbanModule: ServerModule = {
  id: "kanban",
  requires: ["projects", "workspaces", "agents", "attention"],
  core: false,
  setup(host) {
    host.store.migrate("kanban", MIGRATIONS);
    const projects = host.use(ProjectsKey);
    const workspaces = host.use(WorkspacesKey);
    const agents = host.use(AgentsKey);
    const approvals = host.use(ApprovalsKey);

    const load = (id: string): CardRow => {
      const row = host.store.get<CardRow>("SELECT * FROM kanban_cards WHERE id = ?", id);
      if (!row) throw new ApiError(404, "card_not_found", `No card ${id}`);
      return row;
    };

    const blockerOf = (link: LinkRow): CardBlocker => {
      if (link.kind === "card") {
        const card = load(link.target_id);
        return {
          kind: "card",
          id: card.id,
          title: card.title,
          column: card.column_id,
          open: card.column_id !== "done",
        };
      }
      const workspace = workspaces.get(link.target_id);
      return {
        kind: "workspace",
        id: workspace.id,
        name: workspace.name,
        state: workspace.state,
        open: workspace.state !== "archived",
      };
    };

    const toCard = (row: CardRow): Card => {
      const blockedBy = host.store
        .all<LinkRow>(
          "SELECT * FROM kanban_links WHERE card_id = ? ORDER BY kind, target_id",
          row.id,
        )
        .map(blockerOf);
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        ...(row.project_id === null ? {} : { projectId: row.project_id }),
        labels: readLabels(row),
        ...(row.due === null ? {} : { due: row.due }),
        column: row.column_id,
        position: row.position,
        ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
        blockedBy,
        blocked: blockedBy.some((blocker) => blocker.open),
        ...(row.created_by === null ? {} : { createdBy: readAuthor(row, row.created_by) }),
        ...(row.changed_by === null ? {} : { changedBy: readAuthor(row, row.changed_by) }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    };

    const listCards = (filter: {
      projectId?: string;
      workspaceId?: string;
      label?: string;
      column?: CardColumn;
    }) => {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.column) {
        where.push("column_id = ?");
        params.push(filter.column);
      }
      if (filter.projectId) {
        where.push("project_id = ?");
        params.push(filter.projectId);
      }
      if (filter.workspaceId) {
        where.push("workspace_id = ?");
        params.push(filter.workspaceId);
      }
      const rows = host.store
        .all<CardRow>(
          `SELECT * FROM kanban_cards ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY position, created_at`,
          ...params,
        )
        .sort((a, b) => CARD_COLUMNS.indexOf(a.column_id) - CARD_COLUMNS.indexOf(b.column_id));
      const cards = rows.map(toCard);
      const { label } = filter;
      return label ? cards.filter((card) => card.labels.includes(label)) : cards;
    };

    // The board is small and has one user, so every change sends the whole board.
    const publish = () => {
      const event: BoardEvent = { type: "board", cards: listCards({}) };
      host.events.publish(BOARD_TOPIC, event);
    };
    host.events.onSubscribe(BOARD_TOPIC, (): BoardEvent[] => [
      { type: "board", cards: listCards({}) },
    ]);

    /** Puts a card at `index` in `column` (default: the end) and renumbers that column. */
    const place = (id: string, column: CardColumn, index?: number) => {
      const others = host.store
        .all<{ id: string }>(
          "SELECT id FROM kanban_cards WHERE column_id = ? AND id != ? ORDER BY position, created_at",
          column,
          id,
        )
        .map((row) => row.id);
      others.splice(Math.min(index ?? others.length, others.length), 0, id);
      others.forEach((cardId, position) => {
        host.store.run(
          "UPDATE kanban_cards SET column_id = ?, position = ? WHERE id = ?",
          column,
          position,
          cardId,
        );
      });
    };

    /** Numbers a column from 0 again, after a card left it. */
    const renumber = (column: CardColumn) => {
      host.store
        .all<{ id: string }>(
          "SELECT id FROM kanban_cards WHERE column_id = ? ORDER BY position, created_at",
          column,
        )
        .forEach((other, position) => {
          host.store.run("UPDATE kanban_cards SET position = ? WHERE id = ?", position, other.id);
        });
    };

    const record = (id: string, from: CardColumn | null, to: CardColumn, reason: string) => {
      host.store.run(
        "INSERT INTO kanban_events (card_id, at, from_column, to_column, reason) VALUES (?, ?, ?, ?, ?)",
        id,
        host.now(),
        from,
        to,
        reason,
      );
    };

    /** Moves a card. A move to another column goes into its history; a reorder in the same column does not. */
    const move = (row: CardRow, column: CardColumn, index: number | undefined, reason: string) => {
      host.store.transaction(() => {
        // Without an index, a card that stays in its column keeps its place.
        if (column !== row.column_id || index !== undefined) place(row.id, column, index);
        if (column !== row.column_id) {
          renumber(row.column_id);
          record(row.id, row.column_id, column, reason);
          host.store.run("UPDATE kanban_cards SET updated_at = ? WHERE id = ?", host.now(), row.id);
        }
      });
    };

    /** Checks that the project and blockers exist. Blockers come back without repeats. */
    const checkRefs = async (
      projectId: string | null | undefined,
      blockers: readonly BlockerRef[] | undefined,
      selfId?: string,
    ): Promise<BlockerRef[] | undefined> => {
      if (projectId) await projects.get(projectId);
      if (!blockers) return undefined;
      const unique = new Map(blockers.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
      for (const ref of unique.values()) {
        if (ref.kind === "card") {
          if (ref.id === selfId)
            throw new ApiError(422, "self_blocker", "A card cannot block itself");
          load(ref.id);
        } else workspaces.get(ref.id);
      }
      return [...unique.values()];
    };

    const setBlockers = (id: string, blockers: readonly BlockerRef[]) => {
      host.store.run("DELETE FROM kanban_links WHERE card_id = ?", id);
      for (const ref of blockers) {
        host.store.run(
          "INSERT INTO kanban_links (card_id, kind, target_id) VALUES (?, ?, ?)",
          id,
          ref.kind,
          ref.id,
        );
      }
    };

    const workChanged: Cards["workChanged"] = (workspaceId, column, reason) => {
      const rows = host.store.all<CardRow>(
        "SELECT * FROM kanban_cards WHERE workspace_id = ? AND column_id != ?",
        workspaceId,
        column,
      );
      for (const row of rows) move(row, column, undefined, reason);
      if (rows.length > 0) publish();
    };

    /** `by`: the agent that made the card; undefined for the user. */
    const createCard = async (request: CreateCardRequest, by?: CardAuthor): Promise<Card> => {
      const blockers = await checkRefs(request.projectId, request.blockedBy);
      const column = request.column ?? "backlog";
      const id = host.newId();
      const now = host.now();
      const author = by ? JSON.stringify(by) : null;
      host.store.transaction(() => {
        host.store.run(
          `INSERT INTO kanban_cards
            (id, title, body, project_id, labels, due, column_id, position, created_by, changed_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          id,
          request.title.trim(),
          request.body ?? "",
          request.projectId ?? null,
          JSON.stringify(cleanLabels(request.labels ?? [])),
          request.due === undefined ? null : checkDue(request.due),
          column,
          author,
          author,
          now,
          now,
        );
        place(id, column);
        if (blockers) setBlockers(id, blockers);
        record(id, null, column, "created");
      });
      publish();
      return toCard(load(id));
    };

    /** A change by the user (`by` undefined) clears `changed_by`, so the board never credits an agent with it. */
    const updateCard = async (
      id: string,
      request: UpdateCardRequest & { column?: CardColumn },
      by?: CardAuthor,
    ): Promise<Card> => {
      const row = load(id);
      const blockers = await checkRefs(request.projectId, request.blockedBy, row.id);
      const next: CardRow = {
        ...row,
        ...(request.title === undefined ? {} : { title: request.title.trim() }),
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.projectId === undefined ? {} : { project_id: request.projectId }),
        ...(request.labels === undefined
          ? {}
          : { labels: JSON.stringify(cleanLabels(request.labels)) }),
        ...(request.due === undefined
          ? {}
          : { due: request.due === null ? null : checkDue(request.due) }),
        changed_by: by ? JSON.stringify(by) : null,
        updated_at: host.now(),
      };
      host.store.transaction(() => {
        host.store.run(
          `UPDATE kanban_cards SET title = ?, body = ?, project_id = ?, labels = ?, due = ?, changed_by = ?,
             updated_at = ?
           WHERE id = ?`,
          next.title,
          next.body,
          next.project_id,
          next.labels,
          next.due,
          next.changed_by,
          next.updated_at,
          row.id,
        );
        if (blockers) setBlockers(row.id, blockers);
        if (request.column !== undefined)
          move(load(row.id), request.column, undefined, by ? "agent" : "manual");
      });
      publish();
      return toCard(load(row.id));
    };

    const openBlockers = (card: Card) =>
      card.blockedBy
        .filter((blocker) => blocker.open)
        .map((blocker) => (blocker.kind === "card" ? blocker.title : blocker.name));

    /** An active workspace that work from a card may start in. Parked ones are refused (ADR 0100). */
    const targetWorkspace = (id: string): Workspace => {
      const workspace = workspaces.get(id);
      if (workspace.state !== "active") {
        throw new ApiError(
          409,
          "workspace_not_active",
          `The workspace "${workspace.name}" is ${workspace.state}; work from a card starts only in an active workspace`,
        );
      }
      return workspace;
    };

    const refuseOpenWorkspace = (row: CardRow) => {
      if (row.workspace_id !== null && workspaces.get(row.workspace_id).state !== "archived") {
        throw new ApiError(
          409,
          "card_has_workspace",
          "This card already has an open workspace; archive it first",
        );
      }
    };

    /**
     * R11.4, ADR 0100: starts work from a card in a new workspace named after it, or in an active workspace of its
     * project. The card links to the workspace and moves to In progress, and its brief goes to the workspace's
     * worker chat in the same transaction. `origin` says who started it, for the brief.
     */
    const startCard = async (
      id: string,
      target: CardStartTarget,
      options: { projectId?: string; confirmBlocked?: boolean; origin: string },
    ): Promise<StartCardResponse> => {
      const row = load(id);
      refuseOpenWorkspace(row);
      const existing = target.kind === "existing" ? targetWorkspace(target.workspaceId) : undefined;
      const asked = existing?.projectId ?? options.projectId;
      if (row.project_id && asked && asked !== row.project_id) {
        throw new ApiError(
          422,
          "project_mismatch",
          existing
            ? "The workspace belongs to another project than the card"
            : "The card belongs to another project",
        );
      }
      const projectId = row.project_id ?? asked;
      if (!projectId) {
        throw new ApiError(400, "project_required", "The card has no project; choose one");
      }
      const card = toCard(row);
      if (card.blocked && options.confirmBlocked !== true) {
        throw new ApiError(
          409,
          "card_blocked",
          `This card is blocked by: ${openBlockers(card).join(", ")}`,
        );
      }
      let created: StartCardResponse["created"];
      let workspace: Workspace;
      if (target.kind === "new") {
        created = await workspaces.create({
          projectId,
          name: row.title,
          isolation: target.isolation,
          ...(target.line ? { line: target.line } : {}),
          ...(target.base ? { base: target.base } : {}),
        });
        workspace = created.workspace;
      } else workspace = existing as Workspace;
      const chat = await agents.activeWorker(workspace.id);
      host.store.transaction(() => {
        host.store.run(
          "UPDATE kanban_cards SET workspace_id = ?, project_id = ?, updated_at = ? WHERE id = ?",
          workspace.id,
          projectId,
          host.now(),
          row.id,
        );
        move(load(row.id), "in-progress", undefined, "workspace-started");
        agents.deliver(chat.id, cardBrief(toCard(load(row.id)), options.origin));
      });
      publish();
      return {
        card: toCard(load(row.id)),
        workspace,
        ...(created ? { created } : {}),
        chatId: chat.id,
      };
    };

    approvals.register({
      kind: CARD_START,
      subject: CardStartSubject,
      approve: async (subject, approval) => {
        const filed = approval.subject as CardStartSubject;
        if (subject.cardId !== filed.cardId) {
          throw new ApiError(
            422,
            "approval_card_changed",
            "Approve can change the target, not the card",
          );
        }
        const asking = workspaces.get(approval.workspaceId);
        const result = await startCard(subject.cardId, subject.target, {
          projectId: asking.projectId,
          confirmBlocked: true,
          origin: `The user approved starting it here, as an agent asked. The agent's reason: ${approval.reason}`,
        });
        return `Card "${result.card.title}" (${result.card.id}) started in ${
          result.created ? "the new" : "the existing"
        } workspace "${result.workspace.name}" (${result.workspace.id}). Its brief went to that workspace's worker chat (${result.chatId}).`;
      },
    });

    const describeTarget = (target: CardStartTarget): string =>
      target.kind === "new"
        ? `a new workspace (${target.isolation === "new" ? "new worktree or copy" : target.isolation})`
        : `the workspace "${workspaces.get(target.workspaceId).name}"`;

    host.provide(CardsKey, {
      forWorkspace: (workspaceId) => listCards({ workspaceId }),
      workChanged,
      list: (filter) => listCards(filter),
      get: (id) => toCard(load(id)),
      create: (request, by) => createCard(request, by),
      update: (id, request, by) => updateCard(id, request, by),
      requestStart: (caller, cardId, request) => {
        const own = workspaces.get(caller.workspaceId);
        const row = load(cardId);
        // ADR 0100: another project's card looks like it does not exist.
        if (row.project_id !== own.projectId)
          throw new ApiError(404, "card_not_found", `No card ${cardId}`);
        refuseOpenWorkspace(row);
        if (request.target.kind === "existing") {
          const workspace = workspaces.get(request.target.workspaceId);
          if (workspace.projectId !== own.projectId) {
            throw new ApiError(
              404,
              "workspace_not_found",
              `No workspace ${request.target.workspaceId}`,
            );
          }
          targetWorkspace(workspace.id);
        }
        const card = toCard(row);
        const blocked = card.blocked ? ` (blocked by: ${openBlockers(card).join(", ")})` : "";
        return approvals.file(caller, {
          kind: CARD_START,
          title: `Start card "${card.title}" in ${describeTarget(request.target)}${blocked}`,
          reason: request.reason,
          subject: { cardId: card.id, target: request.target },
        });
      },
    });

    workspaces.afterStateChange((workspace) => {
      // ADR 0012: any archive counts as done. The user moves the card back if the work was dropped.
      if (workspace.state === "archived") workChanged(workspace.id, "done", "workspace-archived");
      // Blockers show the workspace's state, so the board changes either way.
      publish();
    });

    host.routes.get("/cards", (c) => {
      const projectId = c.req.query("projectId");
      const workspaceId = c.req.query("workspaceId");
      const label = c.req.query("label");
      return c.json({
        cards: listCards({
          ...(projectId ? { projectId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(label ? { label } : {}),
        }),
      });
    });

    host.routes.post("/cards", async (c) => {
      const request = parseJsonBody(CreateCardRequest, await c.req.text(), "create card request");
      return c.json({ card: await createCard(request) }, 201);
    });

    host.routes.get("/cards/:id", (c) => {
      const row = load(c.req.param("id"));
      const history = host.store
        .all<EventRow>(
          "SELECT at, from_column, to_column, reason FROM kanban_events WHERE card_id = ? ORDER BY id",
          row.id,
        )
        .map(
          (event): CardMove => ({
            at: event.at,
            ...(event.from_column === null ? {} : { from: event.from_column }),
            to: event.to_column,
            reason: event.reason,
          }),
        );
      const body: CardDetail = { card: toCard(row), history };
      return c.json(body);
    });

    host.routes.patch("/cards/:id", async (c) => {
      const request = parseJsonBody(UpdateCardRequest, await c.req.text(), "update card request");
      return c.json({ card: await updateCard(c.req.param("id"), request) });
    });

    host.routes.post("/cards/:id/move", async (c) => {
      const request = parseJsonBody(MoveCardRequest, await c.req.text(), "move card request");
      const row = load(c.req.param("id"));
      host.store.transaction(() => {
        move(row, request.column, request.index, "manual");
        host.store.run("UPDATE kanban_cards SET changed_by = NULL WHERE id = ?", row.id);
      });
      publish();
      return c.json({ card: toCard(load(row.id)) });
    });

    host.routes.delete("/cards/:id", (c) => {
      const row = load(c.req.param("id"));
      host.store.transaction(() => {
        host.store.run("DELETE FROM kanban_cards WHERE id = ?", row.id);
        host.store.run(
          "DELETE FROM kanban_links WHERE card_id = ? OR (kind = 'card' AND target_id = ?)",
          row.id,
          row.id,
        );
        host.store.run("DELETE FROM kanban_events WHERE card_id = ?", row.id);
        renumber(row.column_id);
      });
      publish();
      return c.json({ removed: row.id });
    });

    host.routes.post("/cards/:id/start", async (c) => {
      const request = parseJsonBody(StartCardRequest, await c.req.text(), "start card request");
      const target: CardStartTarget =
        "workspaceId" in request
          ? { kind: "existing", workspaceId: request.workspaceId }
          : {
              kind: "new",
              isolation: request.isolation,
              ...(request.line ? { line: request.line } : {}),
              ...(request.base ? { base: request.base } : {}),
            };
      const body = await startCard(c.req.param("id"), target, {
        ...("projectId" in request && request.projectId ? { projectId: request.projectId } : {}),
        ...(request.confirmBlocked ? { confirmBlocked: true } : {}),
        origin: "The user started it here.",
      });
      return c.json(body, 201);
    });
  },
};
