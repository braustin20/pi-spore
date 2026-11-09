import { clampWidth } from "@pi-spore/ui";

const LIST_MIN = 200;
const LIST_MAX = 480;
const RIGHT_MIN = 280;
const RIGHT_MAX_SHARE = 0.7;
const WIDE_DEFAULT = 640;
const CHAT_MIN = 360;
const CLOSED = 40;

export interface PanelSize {
  width: number;
  min: number;
  max: number;
}

const fixed = (width: number): PanelSize => ({ width, min: width, max: width });

// A minimum wins over a lower maximum, so a narrow window overflows instead of squeezing a panel below its minimum.
const sized = (wanted: number, min: number, max: number): PanelSize => {
  const top = Math.max(min, max);
  return { width: clampWidth(wanted, min, top), min, max: top };
};

/**
 * The widths of the workspace list and the right column; a closed column is a 40 px strip, an absent one is 0.
 * The right column gives way first when the window is too narrow, then the list.
 */
export function layoutPanels(input: {
  window: number;
  list: number | "closed";
  right: number | "closed" | "absent";
  wide: boolean;
}): { list: PanelSize; right: PanelSize } {
  const total = input.window;
  const listFirst = input.list === "closed" ? CLOSED : clampWidth(input.list, LIST_MIN, LIST_MAX);

  let right: PanelSize;
  if (input.right === "absent") right = fixed(0);
  else if (input.right === "closed") right = fixed(CLOSED);
  else {
    const wideDefault = Math.min(WIDE_DEFAULT, Math.floor(total / 2));
    const wanted = input.wide ? Math.max(input.right, wideDefault) : input.right;
    const max = Math.min(Math.floor(total * RIGHT_MAX_SHARE), total - listFirst - CHAT_MIN);
    right = sized(wanted, RIGHT_MIN, max);
  }
  if (input.list === "closed") return { list: fixed(CLOSED), right };

  // The list only shrinks when the right column is already at its minimum, so the right column's limits still hold.
  const list = sized(listFirst, LIST_MIN, Math.min(LIST_MAX, total - right.width - CHAT_MIN));
  return { list, right };
}

/** The old fixed widths: 256 and 320 px, a step wider from 1280 px. */
export function defaultWidths(window: number): { list: number; right: number } {
  return window >= 1280 ? { list: 288, right: 352 } : { list: 256, right: 320 };
}

/**
 * What a phone shows: the middle pane, the workspace list drawer, or one tab of the right column as a sheet.
 * A tab pane needs a workspace; without one, or with an unknown pane, the middle pane shows.
 */
export function phonePane(input: {
  pane: string | undefined;
  tabIds: readonly string[];
  hasWorkspace: boolean;
}): "main" | "list" | { tab: string } {
  if (input.pane === "list") return "list";
  if (input.pane !== undefined && input.hasWorkspace && input.tabIds.includes(input.pane))
    return { tab: input.pane };
  return "main";
}
