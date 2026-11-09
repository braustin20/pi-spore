import { useSyncExternalStore } from "react";

/** A phone is narrower than 48rem. This must match Tailwind's `max-md:`; it is the only place JS knows the breakpoint. */
export const PHONE_QUERY = "(width < 48rem)";

function subscribePhone(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches);
}

/** Splits `#/a/b?pane=changes` into the path and the pane. Only the `pane` key matters. */
export function splitHash(hash: string): { path: string; pane: string | undefined } {
  const rest = hash.replace(/^#/, "");
  const at = rest.indexOf("?");
  const path = (at === -1 ? rest : rest.slice(0, at)) || "/";
  const pane = at === -1 ? null : new URLSearchParams(rest.slice(at + 1)).get("pane");
  return { path, pane: pane || undefined };
}

export function paneHref(path: string, pane: string | undefined): string {
  return pane === undefined ? `#${path}` : `#${path}?pane=${encodeURIComponent(pane)}`;
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The pane that is open on a phone, or undefined when the page itself shows. */
export function usePane(): string | undefined {
  return useSyncExternalStore(subscribeHash, () => splitHash(window.location.hash).pane);
}

let openedHash: string | undefined;

export function openPane(pane: string): void {
  window.location.hash = paneHref(splitHash(window.location.hash).path, pane);
  openedHash = window.location.hash;
}

/**
 * Back must close a pane, so opening one adds a history entry and closing it goes back. After a reload, or when the
 * pane came from a link, that entry is not ours: going back could leave the site, so the hash is replaced instead.
 */
export function closePane(): void {
  if (openedHash !== undefined && window.location.hash === openedHash) {
    openedHash = undefined;
    window.history.back();
    return;
  }
  window.location.replace(paneHref(splitHash(window.location.hash).path, undefined));
}
