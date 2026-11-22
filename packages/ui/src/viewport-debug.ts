import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pi-spore.viewport-debug";
const listeners = new Set<() => void>();

/** Turns the viewport numbers overlay on or off and remembers the choice in this browser. */
export function setViewportDebug(on: boolean): void {
  if (on) localStorage.setItem(STORAGE_KEY, "on");
  else localStorage.removeItem(STORAGE_KEY);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the viewport numbers overlay is on. */
export function useViewportDebug(): boolean {
  return useSyncExternalStore(subscribe, () => localStorage.getItem(STORAGE_KEY) === "on");
}
