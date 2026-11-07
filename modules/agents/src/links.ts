/**
 * What a URL in the agent's Markdown points at (ADR 0060, ADR 0061):
 * - `remote`: an `http:` or `https:` address; its image loads only when the user asks;
 * - `local`: a file path, absolute, relative to the workspace folder, or a `file:` URL;
 * - `other`: anything else (`mailto:`, `#anchor`, `data:`), left as a plain link.
 */
export type LinkTarget =
  | { kind: "remote"; url: string; host: string }
  | { kind: "local"; path: string }
  | { kind: "other" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Markdown links write spaces and other characters escaped; a bad escape keeps the text as written. */
function decodePath(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function linkTarget(url: string): LinkTarget {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return { kind: "remote", url: trimmed, host: new URL(trimmed).host };
    } catch {
      return { kind: "other" };
    }
  }
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const { host, pathname } = new URL(trimmed);
      return host === "" ? { kind: "local", path: decodePath(pathname) } : { kind: "other" };
    } catch {
      return { kind: "other" };
    }
  }
  if (trimmed === "" || SCHEME.test(trimmed) || /^[#?]/.test(trimmed) || trimmed.startsWith("//"))
    return { kind: "other" };
  return { kind: "local", path: decodePath(trimmed) };
}

/** A path the chat can show as an image: the server checks the bytes too. */
export const isImagePath = (path: string) => /\.(png|jpe?g|webp|gif)$/i.test(path);

/**
 * react-markdown drops `file:` URLs by default. Keep them, so `linkTarget` sees them; every other URL gets the default
 * treatment.
 */
export function keepFileUrls(url: string, fallback: (url: string) => string): string {
  return /^file:\/\//i.test(url.trim()) ? url : fallback(url);
}
