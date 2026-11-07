/** v1 keeps the terminal font in the browser, as it keeps the theme; the settings module moves it later. */
export const FONT_STORAGE_KEY = "pi-spore.terminal-font";

// Quotes, commas, and semicolons could break out of the CSS font list, so a name may not have them.
const FONT_NAME = /^[\p{L}\p{N} ._-]{1,100}$/u;

/**
 * The font family name the user typed, trimmed, or undefined for none. Throws for a name with other characters.
 */
export function parseFontName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") return undefined;
  if (!FONT_NAME.test(name)) {
    throw new Error("A font name may have letters, digits, spaces, '.', '_', and '-' only");
  }
  return name;
}

/** The stored font. A stored value that is not a valid name (edited by hand) gives none. */
export function readFont(storage: Pick<Storage, "getItem">): string | undefined {
  const stored = storage.getItem(FONT_STORAGE_KEY);
  if (stored === null) return undefined;
  try {
    return parseFontName(stored);
  } catch {
    console.warn(`pi-spore: ignoring the stored terminal font "${stored}"; it is not a font name`);
    return undefined;
  }
}

/**
 * The CSS font list of a terminal: the user's font first, then the app's mono font. The Nerd Fonts symbols font
 * comes next, for prompt icons that the other fonts do not have. It is used when it is installed.
 */
export function fontStack(custom: string | undefined): string {
  return [
    ...(custom ? [`"${custom}"`] : []),
    `"JetBrains Mono Variable"`,
    `"Symbols Nerd Font Mono"`,
    "ui-monospace",
    "monospace",
  ].join(", ");
}
