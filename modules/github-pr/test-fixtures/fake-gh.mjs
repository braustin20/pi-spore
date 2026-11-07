// A stand-in for `gh` in tests. Usage: node fake-gh.mjs <state.json> <gh args...>
// The state file holds the fake GitHub, and every call is appended to `calls` in it:
//   prs:      [{ number, url, title, state, isDraft, headRefName, baseRefName, headRefOid, reviewDecision,
//               mergeable, statusCheckRollup }]
//   comments: { comment: [...], review: [...], review_comment: [...] } (REST items, one page each)
//   logs:     { "<job id>": "log text" }
//   createError: a message `gh pr create` fails with
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
  const pr = state.prs.find(
    (candidate) =>
      String(candidate.number) === selector ||
      candidate.url === selector ||
      (candidate.headRefName === selector && candidate.state === "OPEN"),
  );
  if (!pr) fail(`no pull requests found for branch "${selector}"`);
  save();
  process.stdout.write(JSON.stringify(pr));
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
