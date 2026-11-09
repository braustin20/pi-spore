import type { WebPage } from "@pi-spore/module-api";
import { splitHash } from "@pi-spore/ui";
import { useEffect, useState } from "react";

/** Matches `/projects/:id` against `/projects/01ABC`. Returns the params, or undefined if it does not match. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  if (want.length !== have.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    const actual = have[i] as string;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(actual);
    else if (part !== actual) return undefined;
  }
  return params;
}

export function findPage(
  pages: readonly WebPage[],
  path: string,
): { page: WebPage; params: Record<string, string> } | undefined {
  for (const page of pages) {
    const params = matchPath(page.path, path);
    if (params) return { page, params };
  }
  return undefined;
}

/**
 * Whether a rail entry for the page at `pagePath` is lit on `path`: on the page itself and every path below it.
 * Home (`/`) has no path below it, since no path starts with `//`.
 */
export function railActive(pagePath: string, path: string): boolean {
  return path === pagePath || path.startsWith(`${pagePath}/`);
}

function readHashPath(): string {
  return splitHash(window.location.hash).path;
}

export function useHashPath(): string {
  const [path, setPath] = useState(readHashPath);
  useEffect(() => {
    const onChange = () => setPath(readHashPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}
