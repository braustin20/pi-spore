import { useSyncExternalStore } from "react";
import { sporeLogoSvg } from "./components/spore-logo.js";

export interface Theme {
  /** The `data-theme` value of the theme's block in themes.css. */
  id: string;
  name: string;
}

/** The built-in themes, in menu order. Each has one block in themes.css. */
export const THEMES: readonly Theme[] = [
  { id: "spore-night", name: "Spore Night" },
  { id: "ayu-dark", name: "Ayu Dark" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha" },
  { id: "dracula", name: "Dracula" },
  { id: "everforest-dark", name: "Everforest Dark" },
  { id: "gruvbox-dark", name: "Gruvbox Dark" },
  { id: "monokai", name: "Monokai" },
  { id: "nord", name: "Nord" },
  { id: "one-dark", name: "One Dark" },
  { id: "primer-dark", name: "Primer Dark" },
  { id: "solarized-dark", name: "Solarized Dark" },
  { id: "tokyo-night", name: "Tokyo Night" },
  { id: "spore-day", name: "Spore Day" },
];

export const DEFAULT_THEME = "spore-night";

/** v1 keeps the choice in the browser; the settings module moves it to settings.json later (docs/design.md). */
export const THEME_STORAGE_KEY = "pi-spore.theme";

/** The stored theme id. An id that no built-in theme has (for example a removed theme) gives the default. */
export function readTheme(storage: Pick<Storage, "getItem">): string {
  const stored = storage.getItem(THEME_STORAGE_KEY);
  if (stored === null) return DEFAULT_THEME;
  if (THEMES.some((theme) => theme.id === stored)) return stored;
  console.warn(`pi-spore: unknown theme "${stored}" in localStorage; using ${DEFAULT_THEME}`);
  return DEFAULT_THEME;
}

const listeners = new Set<() => void>();
let current: string | undefined;

/** Applies a theme to the page at once and stores it. Throws for an id that no built-in theme has. */
export function setTheme(id: string): void {
  if (!THEMES.some((theme) => theme.id === id)) throw new Error(`Unknown theme "${id}"`);
  localStorage.setItem(THEME_STORAGE_KEY, id);
  show(id);
}

function show(id: string): void {
  current = id;
  document.documentElement.dataset.theme = id;
  for (const listener of listeners) listener();
}

/** Applies the stored theme. Call once before the first render, so the page does not flash the default. */
export function initTheme(): void {
  subscribe(showFavicon);
  show(readTheme(localStorage));
  // Another tab changed the theme.
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY) show(readTheme(localStorage));
  });
}

/** Redraws the favicon in the theme's accent, so the tab matches the page. */
function showFavicon(): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) throw new Error('pi-spore: the page has no <link rel="icon"> for the favicon');
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  if (!accent) throw new Error("pi-spore: the theme sets no --accent for the favicon");
  link.href = `data:image/svg+xml,${encodeURIComponent(sporeLogoSvg(accent))}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The id of the theme on the page. */
export function useTheme(): string {
  return useSyncExternalStore(subscribe, () => current ?? DEFAULT_THEME);
}
