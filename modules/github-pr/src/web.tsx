import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  type PrCheck,
  PrEvent,
  PrStatus,
  type PrWatchState,
  type PullRequest,
  parse,
  type Workspace,
} from "@pi-spore/shared";
import {
  Button,
  Checkbox,
  Chip,
  CollapsibleSection,
  EmptyState,
  Field,
  Input,
  Notice,
  SectionLabel,
  Spinner,
  Textarea,
  type Tone,
  Tooltip,
} from "@pi-spore/ui";
import { ArrowRight, ExternalLink, GitPullRequest, RefreshCw } from "lucide-react";
import { type SubmitEvent, useCallback, useEffect, useState } from "react";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const CHECK_TONES: Record<PrCheck["state"], Tone> = {
  pending: "run",
  pass: "ok",
  fail: "fail",
  cancelled: "neutral",
  skipped: "neutral",
  neutral: "neutral",
};

const WATCH: Record<PrWatchState, { text: string; tone: Tone }> = {
  off: { text: "Not watching", tone: "neutral" },
  watching: { text: "Watching", tone: "run" },
  waiting: { text: "Waiting for you", tone: "warn" },
  done: { text: "Done", tone: "neutral" },
};

function stateChip(pr: PullRequest) {
  if (pr.state === "merged") return <Chip tone="ok">Merged</Chip>;
  if (pr.state === "closed") return <Chip>Closed</Chip>;
  return pr.draft ? <Chip>Draft</Chip> : <Chip tone="accent">Open</Chip>;
}

function reviewChip(pr: PullRequest) {
  if (pr.review === "approved") return <Chip tone="ok">Approved</Chip>;
  if (pr.review === "changes_requested") return <Chip tone="fail">Changes requested</Chip>;
  if (pr.review === "review_required") return <Chip tone="warn">Review required</Chip>;
  return <Chip>No review</Chip>;
}

function mergeChip(pr: PullRequest) {
  if (pr.mergeable === "conflicting") return <Chip tone="fail">Conflicts with {pr.base}</Chip>;
  if (pr.mergeable === "mergeable") return <Chip tone="ok">No conflicts</Chip>;
  return <Chip>Checking conflicts</Chip>;
}

/** The PR status of a workspace, live: loaded (and refreshed from GitHub) on open, then from the topic. */
function usePrStatus(workspace: Workspace, refreshOnOpen: boolean) {
  const api = useApi();
  const [status, setStatus] = useState<PrStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const path = `github-pr/workspaces/${workspace.id}`;

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(undefined);
      try {
        setStatus(
          parse(PrStatus, await api.get(refresh ? `${path}?refresh=1` : path), "PR status"),
        );
      } catch (caught) {
        setError(message(caught));
      } finally {
        setLoading(false);
      }
    },
    [api, path],
  );

  useEffect(() => {
    void load(refreshOnOpen);
  }, [load, refreshOnOpen]);

  useEffect(
    () =>
      api.subscribe(`github-pr:${workspace.id}`, (raw) =>
        setStatus(parse(PrEvent, raw, "PR event").status),
      ),
    [api, workspace.id],
  );

  /** Runs a request that answers with the status. */
  const act = async (method: "POST", suffix: string, body: unknown) => {
    setError(undefined);
    try {
      setStatus(parse(PrStatus, await api.send(method, `${path}/${suffix}`, body), "PR status"));
      return true;
    } catch (caught) {
      setError(message(caught));
      return false;
    }
  };
  return { status, error, loading, load, act };
}

function PublishForm({
  status,
  workspace,
  act,
}: {
  status: PrStatus;
  workspace: Workspace;
  act: (method: "POST", suffix: string, body: unknown) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(status.defaults.title);
  const [body, setBody] = useState(status.defaults.body);
  const [base, setBase] = useState(status.defaults.base ?? "");
  const [draft, setDraft] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setConfirming(true);
  };
  const publish = async () => {
    setBusy(true);
    const ok = await act("POST", "publish", {
      title: title.trim(),
      body,
      base: base.trim(),
      ...(draft ? { draft: true } : {}),
      confirm: true,
    });
    setBusy(false);
    if (!ok) setConfirming(false);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-4">
      <SectionLabel>Open a pull request</SectionLabel>
      <Field label="Title">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={256}
        />
      </Field>
      <Field label="Description">
        <Textarea rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <Field label="Into branch">
        <Input
          value={base}
          onChange={(event) => setBase(event.target.value)}
          required
          className="font-mono"
          placeholder="main"
        />
      </Field>
      <Checkbox
        label="Open as a draft"
        checked={draft}
        onChange={(event) => setDraft(event.target.checked)}
      />
      {status.local.uncommitted > 0 && (
        <Notice tone="warn">
          {status.local.uncommitted} uncommitted file
          {status.local.uncommitted === 1 ? " is" : "s are"} not part of the PR. Only commits are
          pushed.
        </Notice>
      )}
      {confirming ? (
        <Notice tone="warn">
          <p>
            This pushes <code>{workspace.line}</code> to the remote and opens a pull request on
            GitHub into <code>{base}</code>. Others with access to the repository can see it.
          </p>
          <div className="mt-2 flex gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void publish()}>
              {busy && <Spinner />}
              Push and open PR
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </Notice>
      ) : (
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={title.trim() === "" || base.trim() === ""}
          >
            <GitPullRequest />
            Push and open PR…
          </Button>
        </div>
      )}
    </form>
  );
}

function PrView({
  status,
  pr,
  act,
}: {
  status: PrStatus;
  pr: PullRequest;
  act: (method: "POST", suffix: string, body: unknown) => Promise<boolean>;
}) {
  const [confirmPush, setConfirmPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const { watch } = status;
  const watchShown = WATCH[watch.state];
  const unpushed = status.local.headId !== undefined && status.local.headId !== pr.headId;
  const run = async (work: () => Promise<boolean>) => {
    setBusy(true);
    await work();
    setBusy(false);
  };
  const failing = pr.checks.filter((check) => check.state === "fail").length;
  const passing = pr.checks.filter((check) => check.state === "pass").length;
  const merge = () => {
    if (!window.confirm(`Merge #${pr.number} into ${pr.base} with a merge commit?`)) return;
    void run(() => act("POST", "merge", { confirm: true, headId: pr.headId }));
  };
  const mergeButton = (
    <Button
      variant="primary"
      size="sm"
      disabled={busy || status.mergeBlocked !== undefined}
      onClick={merge}
    >
      Merge
    </Button>
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="rounded-xl border border-line bg-raised/40 p-3">
        <div className="flex items-start gap-2">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 font-medium text-fg hover:text-accent-strong"
          >
            <span className="text-muted">#{pr.number}</span> {pr.title}
            <ExternalLink aria-hidden="true" className="ml-1 inline size-3.5 text-muted" />
          </a>
          {stateChip(pr)}
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <Chip mono title={pr.line} className="min-w-0 shrink">
            {pr.line}
          </Chip>
          <ArrowRight aria-label="into" className="size-3.5 shrink-0 text-muted" />
          <Chip mono title={pr.base}>
            {pr.base}
          </Chip>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {reviewChip(pr)}
          {pr.state === "open" && mergeChip(pr)}
        </div>
        {pr.state === "open" && (
          <div className="mt-3">
            {status.mergeBlocked ? (
              <Tooltip label={status.mergeBlocked}>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button gets no hover or focus, so the wrapper carries the tooltip. */}
                <span tabIndex={0} className="inline-block">
                  {mergeButton}
                </span>
              </Tooltip>
            ) : (
              mergeButton
            )}
          </div>
        )}
      </div>

      {pr.state === "open" && unpushed && (
        <Notice tone="warn">
          <p>The workspace has commits the PR does not have yet.</p>
          {confirmPush ? (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(() => act("POST", "push", { confirm: true })).then(() =>
                    setConfirmPush(false),
                  )
                }
              >
                Push to {pr.line}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmPush(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" className="mt-2" onClick={() => setConfirmPush(true)}>
              Push…
            </Button>
          )}
        </Notice>
      )}
      {status.local.uncommitted > 0 && pr.state === "open" && (
        <p className="text-xs text-muted">
          {status.local.uncommitted} uncommitted file{status.local.uncommitted === 1 ? "" : "s"} in
          the workspace.
        </p>
      )}

      <section aria-label="Checks">
        <div className="mb-1.5 flex items-center gap-2">
          <SectionLabel>Checks</SectionLabel>
          {pr.checks.length > 0 && (
            <span className="text-xs text-muted">
              {passing} of {pr.checks.length} passed{failing > 0 ? `, ${failing} failed` : ""}
            </span>
          )}
        </div>
        {pr.checks.length === 0 ? (
          <p className="text-sm text-muted">No checks on this commit.</p>
        ) : (
          <ul className="flex flex-col">
            {pr.checks.map((check) => (
              <li
                key={`${check.workflow ?? ""}/${check.name}`}
                className="flex items-center gap-2 border-t border-line py-1.5 text-sm first:border-t-0"
              >
                <Chip tone={CHECK_TONES[check.state]} className="w-16 text-center">
                  {check.state}
                </Chip>
                <span className="min-w-0 flex-1 truncate">
                  {check.workflow && <span className="text-muted">{check.workflow} / </span>}
                  {check.name}
                </span>
                {check.url && (
                  <a
                    href={check.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${check.name}`}
                    className="text-muted hover:text-accent-strong"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {pr.state === "open" && (
        <section aria-label="Watch" className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <SectionLabel>Watch</SectionLabel>
            <Chip tone={watchShown.tone}>{watchShown.text}</Chip>
            {watch.state !== "off" && (
              <span className="text-xs text-muted">
                tries {watch.tries}/{watch.maxTries}
              </span>
            )}
          </div>
          <p className="text-xs text-muted">
            pi-spore sends failed checks and review-bot comments to the worker, at most{" "}
            {watch.maxTries} times in a row. It never merges by itself.
            {watch.polledAt ? ` Last look ${time(watch.polledAt)}.` : ""}
            {watch.nextPollAt && watch.state !== "off" ? ` Next ${time(watch.nextPollAt)}.` : ""}
          </p>
          {watch.message && (
            <Notice tone={watch.state === "waiting" ? "warn" : "info"}>{watch.message}</Notice>
          )}
          <div className="flex gap-2">
            {watch.state === "off" && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void run(() => act("POST", "watch", { on: true }))}
              >
                Watch checks
              </Button>
            )}
            {watch.state === "waiting" && (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void run(() => act("POST", "watch", { on: true }))}
              >
                Resume and send again
              </Button>
            )}
            {(watch.state === "watching" || watch.state === "waiting") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => act("POST", "watch", { on: false }))}
              >
                Stop watching
              </Button>
            )}
          </div>
          {status.tries.length > 0 && (
            <ul className="flex flex-col text-xs text-muted">
              {status.tries.map((entry) => (
                <li key={`${entry.at}-${entry.headId}`} className="border-t border-line py-1">
                  {time(entry.at)} · {entry.summary}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** The PR tab (R9): publish the branch, then the PR's state, checks, and watch. */
function PrTab({ workspace }: { workspace: Workspace }) {
  const { status, error, loading, load, act } = usePrStatus(workspace, true);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-sm text-muted">GitHub pull request</span>
        <span className="flex-1" />
        {loading && <Spinner />}
        <Tooltip label="Refresh from GitHub" side="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh from GitHub"
            onClick={() => void load(true)}
          >
            <RefreshCw />
          </Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <Notice tone="fail" className="m-3">
            {error}
          </Notice>
        )}
        {status &&
          (status.pr ? (
            <PrView status={status} pr={status.pr} act={act} />
          ) : status.publishable ? (
            <PublishForm key={workspace.id} status={status} workspace={workspace} act={act} />
          ) : (
            <EmptyState icon={GitPullRequest} title="No pull request">
              {status.reason}
            </EmptyState>
          ))}
      </div>
    </div>
  );
}

/** A short PR line in the Details tab, so "waiting for you" shows without opening the PR tab. */
function PrPanel({ workspace }: { workspace: Workspace }) {
  const { status } = usePrStatus(workspace, false);
  const pr = status?.pr;
  if (!status || !pr) return null;
  const watch = WATCH[status.watch.state];
  const failing = pr.checks.filter((check) => check.state === "fail").length;
  return (
    <CollapsibleSection title="Pull request">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="text-fg hover:text-accent-strong"
        >
          #{pr.number}
        </a>
        {stateChip(pr)}
        {failing > 0 && <Chip tone="fail">{failing} failing</Chip>}
        {pr.state === "open" && pr.mergeable === "conflicting" && (
          <Chip tone="fail">Conflicts</Chip>
        )}
        {status.watch.state !== "off" && status.watch.state !== "done" && (
          <Chip tone={watch.tone}>{watch.text}</Chip>
        )}
      </div>
    </CollapsibleSection>
  );
}

export const githubPrWeb: WebModule = {
  id: "github-pr",
  requires: ["workspaces"],
  core: false,
  setup(host) {
    const view = host.use(WorkspaceViewKey);
    view.addTab({ id: "pr", title: "PR", order: 5, component: PrTab });
    view.addPanel({ id: "pr", order: 5, component: PrPanel });
  },
};
