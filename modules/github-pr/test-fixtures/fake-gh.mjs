// A stand-in for `gh` in tests. Usage: node fake-gh.mjs <state.json> <gh args...>
// The state file holds the fake GitHub, and every call is appended to `calls` in it:
//   prs:      [{ number, url, title, state, isDraft, headRefName, baseRefName, headRefOid, reviewDecision,
//               mergeable, statusCheckRollup }]
//   comments: { comment: [...], review: [...], review_comment: [...] } (REST items, one page each)
//   logs:     { "<job id>": "log text" }
//   createError: a message `gh pr create` fails with
//   viewError:   a message `gh pr view` fails with
//   mergeError:  a message `gh pr merge` fails with
//   holdView:    the path of a FIFO; the next `gh pr view` answers, then waits until something is written to it
//                (the knob is used up by that call), so a test can change things while a poll is in flight
// It answers only the commands pi-spore may run. Anything else exits 99, so a test sees a forbidden call.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [statePath, ...args] = process.argv.slice(2);
let state;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch (error) {
  process.stderr.write(`fake gh: cannot read the state file ${statePath}: ${error.message}\n`);
  process.exit(98);
}
state.calls = [...(state.calls ?? []), args];
state.prs ??= [];
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (message, code = 1) => {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const [group, command] = args;
if (group === "pr" && command === "view") {
  const selector = args[2];
  if (state.viewError) fail(state.viewError);
  // A branch matches a PR in any state, as in gh: an open one first, else the highest number.
  const onBranch = state.prs.filter((candidate) => candidate.headRefName === selector);
  const pr =
    state.prs.find(
      (candidate) => String(candidate.number) === selector || candidate.url === selector,
    ) ??
    onBranch.find((candidate) => candidate.state === "OPEN") ??
    onBranch.sort((a, b) => b.number - a.number)[0];
  if (!pr) fail(`no pull requests found for branch "${selector}"`);
  const hold = state.holdView;
  delete state.holdView;
  save();
  process.stdout.write(JSON.stringify(pr));
  if (hold) readFileSync(hold);
} else if (group === "pr" && command === "create") {
  if (state.createError) fail(state.createError);
  const number = state.prs.length + 1;
  const head = flag("head");
  const url = `https://github.com/owner/repo/pull/${number}`;
  state.prs.push({
    number,
    url,
    title: flag("title"),
    body: flag("body"),
    state: "OPEN",
    isDraft: args.includes("--draft"),
    headRefName: head,
    baseRefName: flag("base"),
    headRefOid: execFileSync("git", ["rev-parse", head], { encoding: "utf8" }).trim(),
    reviewDecision: "",
    mergeable: "UNKNOWN",
    statusCheckRollup: [],
  });
  save();
  process.stdout.write(`${url}\n`);
} else if (
  group === "pr" &&
  command === "merge" &&
  args.length === 6 &&
  args[3] === "--merge" &&
  args[4] === "--match-head-commit"
) {
  // Only the one merge form pi-spore may run (ADR 0142); any other flag falls through to the refusal below.
  if (state.mergeError) fail(state.mergeError);
  const pr = state.prs.find((candidate) => String(candidate.number) === args[2]);
  if (!pr) fail(`no pull request #${args[2]}`);
  if (pr.headRefOid !== args[5]) fail("Head branch was modified. Review and try the merge again.");
  pr.state = "MERGED";
  save();
} else if (group === "run" && command === "view" && args.includes("--log-failed")) {
  const job = args[args.indexOf("--job") + 1];
  const log = state.logs?.[job];
  if (log === undefined) fail(`no log for job ${job}`);
  save();
  process.stdout.write(log);
} else if (group === "api" && args.includes("--method=GET") && args.includes("--slurp")) {
  const path = args.at(-1);
  const kind = /issues\/\d+\/comments$/.test(path)
    ? "comment"
    : /pulls\/\d+\/reviews$/.test(path)
      ? "review"
      : /pulls\/\d+\/comments$/.test(path)
        ? "review_comment"
        : undefined;
  if (!kind) fail(`fake gh: unknown api path ${path}`, 99);
  save();
  process.stdout.write(JSON.stringify([state.comments?.[kind] ?? []]));
} else {
  fail(`fake gh: refused ${args.join(" ")}`, 99);
}
