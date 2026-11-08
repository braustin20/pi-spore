/** A leading `cd <folder> &&` or `cd <folder>;`. */
const LEADING_CD = /^cd (\S+)\s*(&&|;)\s*/;

/**
 * The collapsed row of a bash call: the first line of the command, without a leading `cd` into a pi-spore worktree.
 * That path fills the row and hides the real command. Any other `cd` stays, because it changes what the command does.
 */
export function bashSummary(command: string): string {
  const cd = LEADING_CD.exec(command);
  const rest = cd?.[1]?.includes("/.pi-spore/worktrees/") ? command.slice(cd[0].length) : command;
  return rest.split("\n")[0] ?? "";
}
