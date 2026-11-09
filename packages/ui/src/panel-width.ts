import { useCallback, useEffect, useState } from "react";

const STEP = 16;
const BIG_STEP = 64;

/** Whole pixels inside the limits. A minimum above the maximum wins. */
export function clampWidth(width: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(width)));
}

/**
 * The new width after an arrow key, or undefined for any other key. `grow` is 1 for a panel on the left (its edge
 * moves right to widen it) and -1 for a panel on the right.
 */
export function stepWidth(
  width: number,
  key: string,
  shiftKey: boolean,
  grow: 1 | -1,
): number | undefined {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined;
  const edgeMove = (key === "ArrowRight" ? 1 : -1) * (shiftKey ? BIG_STEP : STEP);
  return width + grow * edgeMove;
}

let storageReported = false;
// Blocked storage is a setting of the browser, not a fault, so the width just does not persist. Say so once.
function reportBlockedStorage(key: string, caught: unknown): void {
  if (storageReported) return;
  storageReported = true;
  console.error(
    `pi-spore: cannot use browser storage for "${key}"; the width is not remembered`,
    caught,
  );
}

/** A stored whole number of pixels above zero; anything else gives `fallback`. */
export function readWidth(
  storage: Pick<Storage, "getItem">,
  key: string,
  fallback: number,
): number {
  let stored: string | null;
  try {
    stored = storage.getItem(key);
  } catch (caught) {
    reportBlockedStorage(key, caught);
    return fallback;
  }
  if (stored === null || !/^\d+$/.test(stored)) return fallback;
  const width = Number(stored);
  return width > 0 ? width : fallback;
}

export function writeWidth(storage: Pick<Storage, "setItem">, key: string, width: number): void {
  try {
    storage.setItem(key, String(width));
  } catch (caught) {
    reportBlockedStorage(key, caught);
  }
}

/** A panel width that the browser remembers. */
export function useStoredWidth(key: string, fallback: number): [number, (width: number) => void] {
  const [value, setValue] = useState(() => readWidth(localStorage, key, fallback));
  const set = useCallback(
    (next: number) => {
      writeWidth(localStorage, key, next);
      setValue(next);
    },
    [key],
  );
  return [value, set];
}

export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}
