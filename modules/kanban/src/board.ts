import { CARD_COLUMNS, type Card, type CardColumn } from "@pi-spore/shared";

/** The local calendar day of `date`, as `YYYY-MM-DD`. Due dates are local days too. */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether an open card's due day has passed or is today. Done cards are never late. */
export function dueState(card: Card, today: string): "overdue" | "today" | undefined {
  if (!card.due || card.column === "done") return undefined;
  if (card.due < today) return "overdue";
  return card.due === today ? "today" : undefined;
}

export interface BoardFilter {
  /** A project id, `none` for cards without a project, or empty for all. */
  projectId: string;
  /** A label, or empty for all. */
  label: string;
  /** Show cards whose workspace retention deleted (ADR 0121). */
  showArchived: boolean;
}

export function filterCards(cards: readonly Card[], filter: BoardFilter): Card[] {
  return cards.filter(
    (card) =>
      (filter.showArchived || card.archivedAt === undefined) &&
      (filter.projectId === "" ||
        (filter.projectId === "none" ? !card.projectId : card.projectId === filter.projectId)) &&
      (filter.label === "" || card.labels.includes(filter.label)),
  );
}

/** Cards per column, in position order. */
export function byColumn(cards: readonly Card[]): Record<CardColumn, Card[]> {
  const columns = Object.fromEntries(CARD_COLUMNS.map((column) => [column, [] as Card[]]));
  for (const card of [...cards].sort((a, b) => a.position - b.position)) {
    columns[card.column]?.push(card);
  }
  return columns as Record<CardColumn, Card[]>;
}

/** Every label in use, sorted. */
export function labelsOf(cards: readonly Card[]): string[] {
  return [...new Set(cards.flatMap((card) => card.labels))].sort((a, b) => a.localeCompare(b));
}

/**
 * The index to send when `draggedId` is dropped before `targetId` in a column, or at its end without a target. The
 * server counts the column without the moved card, so a card that moves down lands one place earlier.
 */
export function dropIndex(
  column: readonly Card[],
  draggedId: string,
  targetId: string | undefined,
): number {
  const others = column.filter((card) => card.id !== draggedId);
  if (targetId === undefined) return others.length;
  const index = others.findIndex((card) => card.id === targetId);
  return index === -1 ? others.length : index;
}

export type Step = "left" | "right" | "up" | "down";

/** Where a keyboard move sends a card, or undefined at the edge of the board. */
export function stepTarget(
  card: Card,
  step: Step,
  columns: Readonly<Record<CardColumn, readonly Card[]>>,
): { column: CardColumn; index?: number } | undefined {
  const at = CARD_COLUMNS.indexOf(card.column);
  if (step === "left" || step === "right") {
    const column = CARD_COLUMNS[at + (step === "left" ? -1 : 1)];
    return column ? { column } : undefined;
  }
  const index = columns[card.column].findIndex((candidate) => candidate.id === card.id);
  const next = index + (step === "up" ? -1 : 1);
  if (index === -1 || next < 0 || next >= columns[card.column].length) return undefined;
  return { column: card.column, index: next };
}
