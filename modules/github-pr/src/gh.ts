import { ApiError, type Exec } from "@pi-spore/module-api";
import {
  type PrCheck,
  type PrCheckState,
  type PrMergeable,
  type PrReview,
  type PullRequest,
  parse,
} from "@pi-spore/shared";
import Type, { type Static, type TSchema } from "typebox";

/** How to run `gh`. Tests point it at a fake. */
export interface GhCommand {
  command: string;
  args: readonly string[];
}

const PR_FIELDS = [
  "number",
  "url",
  "title",
  "state",
  "isDraft",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "reviewDecision",
  "mergeable",
  "statusCheckRollup",
].join(",");

/** A text field gh may leave out, send as null, or send empty. All three mean "none". */
const MaybeText = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const text = (value: string | null | undefined) => (value ? value : undefined);

const CheckRun = Type.Object({
  __typename: Type.Literal("CheckRun"),
  name: Type.String(),
  status: Type.String(),
  conclusion: Type.String(),
  detailsUrl: MaybeText,
  workflowName: MaybeText,
});

const StatusContext = Type.Object({
  __typename: Type.Literal("StatusContext"),
  context: Type.String(),
  state: Type.String(),
  targetUrl: MaybeText,
});

/** `gh pr view --json` with PR_FIELDS. Other fields gh may add are ignored. */
const GhPullRequest = Type.Object({
  number: Type.Integer(),
  url: Type.String(),
  title: Type.String(),
  state: Type.Union([Type.Literal("OPEN"), Type.Literal("CLOSED"), Type.Literal("MERGED")]),
  isDraft: Type.Boolean(),
  headRefName: Type.String(),
  baseRefName: Type.String(),
  headRefOid: Type.String(),
  reviewDecision: Type.String(),
  mergeable: Type.String(),
  statusCheckRollup: Type.Array(Type.Union([CheckRun, StatusContext])),
});

const GhUser = Type.Union([
  Type.Null(),
  Type.Object({ login: Type.String(), type: Type.String() }),
]);

/** One page item of the REST comment and review lists, as far as pi-spore reads it. */
const GhComment = Type.Object({
  id: Type.Integer(),
  user: GhUser,
  body: Type.Union([Type.String(), Type.Null()]),
  html_url: Type.String(),
  path: Type.Optional(Type.String()),
  line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  original_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
});

/** `gh api --paginate --slurp` wraps each page's array in an outer array. */
const GhPages = Type.Array(Type.Array(GhComment));

/** A review bot's comment, review, or line comment on the PR (Q14: they go to the worker). */
export interface BotComment {
  /** Unique across kinds, such as `review_comment:42`. */
  key: string;
  author: string;
  body: string;
  url: string;
  path?: string;
  line?: number;
}

const RUN_CONCLUSIONS: Record<string, PrCheckState> = {
  SUCCESS: "pass",
  FAILURE: "fail",
  TIMED_OUT: "fail",
  STARTUP_FAILURE: "fail",
  ACTION_REQUIRED: "fail",
  CANCELLED: "cancelled",
  SKIPPED: "skipped",
  NEUTRAL: "neutral",
  STALE: "neutral",
};

const STATUS_STATES: Record<string, PrCheckState> = {
  SUCCESS: "pass",
  FAILURE: "fail",
  ERROR: "fail",
  PENDING: "pending",
  EXPECTED: "pending",
};

const REVIEWS: Record<string, PrReview> = {
  "": "none",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

const MERGEABLE: Record<string, PrMergeable> = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
};

/** Maps a value gh sent through a table; a value pi-spore does not know is an error, not a guess. */
function lookup<T>(table: Record<string, T>, value: string, what: string): T {
  const found = table[value];
  if (found === undefined) throw new Error(`gh sent an unknown ${what}: "${value}"`);
  return found;
}

function toPullRequest(pr: Static<typeof GhPullRequest>): PullRequest {
  const checks: PrCheck[] = pr.statusCheckRollup.map((check) => {
    if (check.__typename === "CheckRun") {
      const workflow = text(check.workflowName);
      const url = text(check.detailsUrl);
      return {
        name: check.name,
        ...(workflow ? { workflow } : {}),
        state:
          check.status === "COMPLETED"
            ? lookup(RUN_CONCLUSIONS, check.conclusion, "check conclusion")
            : "pending",
        ...(url ? { url } : {}),
      };
    }
    const url = text(check.targetUrl);
    return {
      name: check.context,
      state: lookup(STATUS_STATES, check.state, "status state"),
      ...(url ? { url } : {}),
    };
  });
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
    draft: pr.isDraft,
    line: pr.headRefName,
    base: pr.baseRefName,
    headId: pr.headRefOid,
    review: lookup(REVIEWS, pr.reviewDecision, "review decision"),
    mergeable: lookup(MERGEABLE, pr.mergeable, "mergeable state"),
    checks,
  };
}

/** The GitHub Actions job behind a check's link, for its log. */
export function jobIdOf(url: string | undefined): string | undefined {
  return url ? /\/actions\/runs\/\d+\/job\/(\d+)/.exec(url)?.[1] : undefined;
}

/** Drops terminal color codes, which a log tail does not need. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes start with ESC, which is what this removes.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** The end of a log, at most `lines` lines and `bytes` characters. */
export function tail(text: string, lines: number, chars: number): string {
  const kept = stripAnsi(text).trimEnd().split("\n").slice(-lines).join("\n");
  return kept.length > chars ? kept.slice(kept.length - chars) : kept;
}

/**
 * The only gh commands pi-spore runs: read a PR, open one, merge one, read a failed job's log, and GET comment
 * lists. It merges only from the merge route, only in the one form of `merge` below (ADR 0142). Nothing here closes,
 * enables auto-merge, deletes a branch, or pushes (R9.3).
 */
export class Gh {
  constructor(
    private readonly exec: Exec,
    private readonly gh: GhCommand,
  ) {}

  private async run(cwd: string, args: readonly string[], timeoutMs = 60_000) {
    try {
      return await this.exec(this.gh.command, [...this.gh.args, ...args], {
        cwd,
        timeoutMs,
        env: {
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
          GH_PAGER: "cat",
        },
      });
    } catch (error) {
      throw new ApiError(
        422,
        "gh_failed",
        `gh ${args[0]} ${args[1] ?? ""}: ${(error as Error).message}`,
      );
    }
  }

  private async ok(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.run(cwd, args);
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
      throw new ApiError(422, "gh_failed", `gh ${args.slice(0, 2).join(" ")}: ${message}`);
    }
    return result.stdout;
  }

  /** Reads gh's JSON output and checks it; either failing is a 422 that names the command. */
  private json<const S extends TSchema>(schema: S, text: string, what: string): Static<S> {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ApiError(422, "gh_failed", `${what} is not JSON: ${text.slice(0, 200)}`);
    }
    try {
      return parse(schema, value, what);
    } catch (error) {
      throw new ApiError(422, "gh_failed", (error as Error).message);
    }
  }

  /** The PR of a number, URL, or branch; undefined when the branch has none. */
  async view(cwd: string, selector: string): Promise<PullRequest | undefined> {
    const result = await this.run(cwd, ["pr", "view", selector, "--json", PR_FIELDS]);
    if (result.code !== 0) {
      if (/no pull requests found/i.test(result.stderr)) return undefined;
      const message = result.stderr.trim() || `exit code ${result.code}`;
      throw new ApiError(422, "gh_failed", `gh pr view: ${message}`);
    }
    const pr = this.json(GhPullRequest, result.stdout, "gh pr view output");
    try {
      return toPullRequest(pr);
    } catch (error) {
      throw new ApiError(422, "gh_failed", (error as Error).message);
    }
  }

  /** Opens a PR and returns its number. `--flag=value` keeps a title or body that starts with `-` a value. */
  async create(
    cwd: string,
    request: { line: string; base: string; title: string; body: string; draft: boolean },
  ): Promise<number> {
    const output = await this.ok(cwd, [
      "pr",
      "create",
      `--base=${request.base}`,
      `--head=${request.line}`,
      `--title=${request.title}`,
      `--body=${request.body}`,
      ...(request.draft ? ["--draft"] : []),
    ]);
    const number = /\/pull\/(\d+)\s*$/.exec(output.trim())?.[1];
    if (!number)
      throw new ApiError(422, "gh_failed", `gh pr create did not print a PR URL: ${output.trim()}`);
    return Number(number);
  }

  /** Merges with a merge commit if the PR head is still `headId`; the branch stays (ADR 0142). */
  async merge(cwd: string, number: number, headId: string): Promise<void> {
    await this.ok(cwd, ["pr", "merge", String(number), "--merge", "--match-head-commit", headId]);
  }

  /** The failed steps' log of a job, or the reason it could not be read. */
  async failedLog(cwd: string, jobId: string): Promise<{ log?: string; error?: string }> {
    const result = await this.run(cwd, ["run", "view", "--job", jobId, "--log-failed"], 120_000);
    if (result.code !== 0) return { error: result.stderr.trim() || `exit code ${result.code}` };
    return { log: result.stdout };
  }

  /** Comments, reviews, and line comments on the PR by accounts GitHub marks as bots. */
  async botComments(cwd: string, number: number): Promise<BotComment[]> {
    const lists = [
      ["comment", `repos/{owner}/{repo}/issues/${number}/comments`],
      ["review", `repos/{owner}/{repo}/pulls/${number}/reviews`],
      ["review_comment", `repos/{owner}/{repo}/pulls/${number}/comments`],
    ] as const;
    const found: BotComment[] = [];
    for (const [kind, path] of lists) {
      const output = await this.ok(cwd, ["api", "--method=GET", "--paginate", "--slurp", path]);
      const pages = this.json(GhPages, output, `gh api ${kind}s output`);
      for (const item of pages.flat()) {
        const body = item.body?.trim() ?? "";
        if (item.user?.type !== "Bot" || body === "") continue;
        const line = item.line ?? item.original_line ?? undefined;
        found.push({
          key: `${kind}:${item.id}`,
          author: item.user.login,
          body,
          url: item.html_url,
          ...(item.path ? { path: item.path } : {}),
          ...(line ? { line } : {}),
        });
      }
    }
    return found;
  }
}
