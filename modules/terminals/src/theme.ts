import type { ITheme } from "@xterm/xterm";

/** The color of a role token (docs/design.md), such as `--fail`, as the page shows it now. */
export type TokenReader = (token: string) => string;

/**
 * xterm colors from the theme's role tokens, so a terminal follows the theme menu. In a light theme black is the
 * text color and white is the muted gray, so text in either color stays readable on the light background.
 */
export function terminalTheme(read: TokenReader, light: boolean): ITheme {
  const black = light ? read("--text") : read("--raised");
  const white = light ? read("--text-muted") : read("--text");
  return {
    background: read("--panel"),
    foreground: read("--text"),
    cursor: read("--accent-strong"),
    cursorAccent: read("--panel"),
    selectionBackground: read("--line"),
    black,
    white,
    brightBlack: read("--text-muted"),
    brightWhite: white,
    red: read("--fail"),
    brightRed: read("--fail"),
    green: read("--ok"),
    brightGreen: read("--ok"),
    yellow: read("--warn"),
    brightYellow: read("--warn"),
    blue: read("--run"),
    brightBlue: read("--run"),
    magenta: read("--accent"),
    brightMagenta: read("--accent"),
    cyan: read("--accent-strong"),
    brightCyan: read("--accent-strong"),
  };
}
