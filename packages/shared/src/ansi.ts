// Matches, in order: a CSI sequence (ESC [ params intermediates final), an OSC sequence (ended by BEL or ESC \),
// any other two-character ESC sequence, and a stray ESC.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes start with ESC, which is what this removes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[0-~]|\x1b/g;

/** Drops terminal color and link codes, which a log or a message does not need. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** The end of a log, without codes: at most `chars` characters, from a whole line when it had to cut. */
export function logTail(text: string, chars: number): string {
  const clean = stripAnsi(text).trimEnd();
  if (clean.length <= chars) return clean;
  const start = clean.length - chars;
  // The cut fell on a line start: keep that line. Otherwise drop the partial line, unless it is the only one.
  if (clean[start - 1] === "\n") return clean.slice(start);
  const cut = clean.slice(start);
  const newline = cut.indexOf("\n");
  return newline === -1 ? cut : cut.slice(newline + 1);
}
