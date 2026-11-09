import { AgentsWebKey } from "@pi-spore/mod-agents/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  type ChangedFile,
  ChangedFileList,
  type ChangeScopeKind,
  ChangesEvent,
  ChangesSummary,
  type CommentSide,
  type DiffComment,
  DiffCommentList,
  type DiffLine,
  DiffList,
  type FileDiff,
  parse,
  SendCommentsResponse,
  type Workspace,
} from "@pi-spore/shared";
import {
  Button,
  Chip,
  cn,
  DiffCount,
  EmptyState,
  Notice,
  Select,
  Spinner,
  Textarea,
  Tooltip,
  useStoredFlag,
} from "@pi-spore/ui";
import {
  Columns2,
  FileDiff as FileDiffIcon,
  MessageSquarePlus,
  RefreshCw,
  Rows3,
  Send,
  X,
} from "lucide-react";
import { Fragment, type SubmitEvent, useCallback, useEffect, useMemo, useState } from "react";
import { languageOf } from "./highlight.js";
import { colorHunk, type ShownLine, splitRows } from "./rows.js";
import { StagedComments } from "./staged.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const SCOPE_LABELS: Record<ChangeScopeKind, string> = {
  uncommitted: "Uncommitted",
  staged: "Staged",
  line: "Branch",
  record: "One commit",
};

const STATUS: Record<
  ChangedFile["status"],
  { letter: string; tone: "ok" | "run" | "fail" | "warn"; label: string }
> = {
  added: { letter: "A", tone: "ok", label: "Added" },
  modified: { letter: "M", tone: "run", label: "Modified" },
  deleted: { letter: "D", tone: "fail", label: "Deleted" },
  renamed: { letter: "R", tone: "warn", label: "Renamed" },
};

/** Where a comment on this line points: deleted lines by their old number, the rest by their new one. */
function anchorOf(line: DiffLine): { side: CommentSide; line: number } | undefined {
  if (line.kind === "del") return line.oldLine ? { side: "old", line: line.oldLine } : undefined;
  return line.newLine ? { side: "new", line: line.newLine } : undefined;
}

const anchorKey = (side: CommentSide, line: number) => `${side}:${line}`;

function Code({ shown }: { shown: ShownLine }) {
  return (
    <>
      {shown.tokens.length === 0
        ? " "
        : shown.tokens.map((token, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens of a line never reorder
            <span key={index} className={token.className}>
              {token.text}
            </span>
          ))}
    </>
  );
}

const LINE_TONE = {
  add: "bg-diff-add/10",
  del: "bg-diff-del/10",
  context: "",
} as const;

const MARK = { add: "+", del: "-", context: " " } as const;

/** The gutter button that opens a comment on a line. */
function CommentButton({ shown, onOpen }: { shown: ShownLine; onOpen: (key: string) => void }) {
  const anchor = anchorOf(shown.line);
  if (!anchor) return null;
  const label = `Comment on ${anchor.side === "old" ? "old " : ""}line ${anchor.line}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => onOpen(anchorKey(anchor.side, anchor.line))}
      className="absolute top-0.5 left-0.5 cursor-pointer rounded bg-accent text-on-accent opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
    >
      <MessageSquarePlus className="size-3.5" />
    </button>
  );
}

function LineNumbers({ line }: { line: DiffLine }) {
  return (
    <>
      <td className="w-10 pr-1 text-right text-muted select-none">{line.oldLine ?? ""}</td>
      <td className="w-10 pr-2 text-right text-muted select-none">{line.newLine ?? ""}</td>
    </>
  );
}

function CommentBox({
  comment,
  onDelete,
}: {
  comment: DiffComment;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="my-1 flex items-start gap-2 rounded-lg border border-accent/50 bg-raised px-3 py-2 font-sans text-sm whitespace-pre-wrap text-fg">
      <span className="min-w-0 flex-1">{comment.body}</span>
      <Tooltip label="Delete comment" side="left">
        <button
          type="button"
          aria-label="Delete comment"
          className="cursor-pointer rounded p-0.5 text-muted hover:text-fail"
          onClick={() => onDelete(comment.id)}
        >
          <X className="size-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

function CommentForm({
  onSave,
  onCancel,
}: {
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (body.trim() === "") return;
    setBusy(true);
    try {
      await onSave(body);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="my-1 flex flex-col gap-2 font-sans">
      <Textarea
        // biome-ignore lint/a11y/noAutofocus: the user just asked to write a comment here
        autoFocus
        rows={3}
        aria-label="Comment"
        placeholder="What should the agent change here?"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || body.trim() === ""}>
          Add comment
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface DiffProps {
  diff: FileDiff;
  split: boolean;
  comments: readonly DiffComment[];
  onComment: (side: CommentSide, line: number, code: string, body: string) => Promise<void>;
  onDelete: (id: string) => void;
}

/** The comments and the open form under one line, as a full-width row. */
function Extras({
  shown,
  open,
  setOpen,
  columns,
  ...props
}: Omit<DiffProps, "diff" | "split"> & {
  shown: ShownLine;
  open: string | undefined;
  setOpen: (key: string | undefined) => void;
  columns: number;
}) {
  const anchor = anchorOf(shown.line);
  if (!anchor) return null;
  const key = anchorKey(anchor.side, anchor.line);
  const here = props.comments.filter((comment) => anchorKey(comment.side, comment.line) === key);
  if (here.length === 0 && open !== key) return null;
  return (
    <tr>
      <td colSpan={columns} className="px-3">
        {here.map((comment) => (
          <CommentBox key={comment.id} comment={comment} onDelete={props.onDelete} />
        ))}
        {open === key && (
          <CommentForm
            onCancel={() => setOpen(undefined)}
            onSave={async (body) => {
              await props.onComment(anchor.side, anchor.line, shown.line.text, body);
              setOpen(undefined);
            }}
          />
        )}
      </td>
    </tr>
  );
}

function DiffView({ diff, split, ...props }: DiffProps) {
  const [open, setOpen] = useState<string | undefined>();
  const language = languageOf(diff.file.path);
  const hunks = useMemo(
    () => diff.hunks.map((hunk) => ({ hunk, lines: colorHunk(hunk, language) })),
    [diff, language],
  );
  if (diff.note) {
    return (
      <Notice className="m-3">
        {diff.note === "binary"
          ? "Binary file. Its contents are not shown."
          : "This file's diff is too large to show here."}
      </Notice>
    );
  }
  if (hunks.length === 0) {
    return <Notice className="m-3">No line changes (a rename or a mode change).</Notice>;
  }
  const columns = split ? 6 : 4;
  return (
    <table className="w-full border-collapse font-mono text-xs leading-5 [tab-size:4]">
      <tbody>
        {hunks.map(({ hunk, lines }) => (
          <Fragment key={`${hunk.oldStart}:${hunk.newStart}`}>
            <tr className="bg-raised text-muted">
              <td colSpan={columns} className="px-3 py-0.5 select-none">
                @@ -{hunk.oldStart} +{hunk.newStart} @@ {hunk.section}
              </td>
            </tr>
            {split
              ? splitRows(lines).map((row) => {
                  const key = `${row.left?.line.oldLine ?? "x"}:${row.right?.line.newLine ?? "x"}`;
                  return (
                    <Fragment key={key}>
                      <tr>
                        {[row.left, row.right].map((side, index) => (
                          <Fragment key={index === 0 ? "left" : "right"}>
                            <td className="w-10 pr-2 text-right align-top text-muted select-none">
                              {side ? (index === 0 ? side.line.oldLine : side.line.newLine) : ""}
                            </td>
                            <td
                              className={cn(
                                "group relative w-1/2 pr-3 pl-5 align-top whitespace-pre-wrap [overflow-wrap:anywhere]",
                                side ? LINE_TONE[side.line.kind] : "bg-raised/50",
                                index === 0 && "border-r border-line",
                              )}
                            >
                              {side && (
                                <>
                                  <CommentButton shown={side} onOpen={setOpen} />
                                  <Code shown={side} />
                                </>
                              )}
                            </td>
                          </Fragment>
                        ))}
                      </tr>
                      {/* A context line shows once, under the right side. */}
                      {row.left && row.left !== row.right && (
                        <Extras
                          shown={row.left}
                          open={open}
                          setOpen={setOpen}
                          columns={4}
                          {...props}
                        />
                      )}
                      {row.right && (
                        <Extras
                          shown={row.right}
                          open={open}
                          setOpen={setOpen}
                          columns={4}
                          {...props}
                        />
                      )}
                    </Fragment>
                  );
                })
              : lines.map((shown) => (
                  <Fragment key={`${shown.line.oldLine ?? "x"}:${shown.line.newLine ?? "x"}`}>
                    <tr className={LINE_TONE[shown.line.kind]}>
                      <LineNumbers line={shown.line} />
                      <td
                        className={cn(
                          "w-4 text-center select-none",
                          shown.line.kind === "add" && "text-diff-add",
                          shown.line.kind === "del" && "text-diff-del",
                        )}
                      >
                        {MARK[shown.line.kind]}
                      </td>
                      <td className="group relative pr-3 pl-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
                        <CommentButton shown={shown} onOpen={setOpen} />
                        <Code shown={shown} />
                        {shown.line.noNewline && (
                          <span className="ml-2 text-muted" title="No newline at end of file">
                            ⏎̸
                          </span>
                        )}
                      </td>
                    </tr>
                    <Extras
                      shown={shown}
                      open={open}
                      setOpen={setOpen}
                      columns={columns}
                      {...props}
                    />
                  </Fragment>
                ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function FileRow({
  file,
  selected,
  comments,
  onSelect,
}: {
  file: ChangedFile;
  selected: boolean;
  comments: number;
  onSelect: () => void;
}) {
  const status = STATUS[file.status];
  const slash = file.path.lastIndexOf("/");
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 border-l-2 px-3 py-1 text-left text-sm hover:bg-raised",
          selected ? "border-accent bg-raised text-fg" : "border-transparent text-muted",
        )}
      >
        <Chip tone={status.tone} mono aria-label={status.label} title={status.label}>
          {status.letter}
        </Chip>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          <span className="text-fg">{file.path.slice(slash + 1)}</span>
          {slash > 0 && <span className="ml-1.5 text-muted">{file.path.slice(0, slash)}</span>}
        </span>
        {comments > 0 && (
          <Chip tone="accent" aria-label={`${comments} comment${comments === 1 ? "" : "s"}`}>
            {comments}
          </Chip>
        )}
        {file.binary ? (
          <span className="font-mono text-xs text-muted">bin</span>
        ) : (
          <DiffCount added={file.additions} deleted={file.deletions} />
        )}
      </button>
    </li>
  );
}

function CommentsBar({
  comments,
  onDelete,
  onSend,
  onStage,
  onShow,
}: {
  comments: readonly DiffComment[];
  onDelete: (id: string) => void;
  onSend: () => Promise<void>;
  onStage: () => void;
  onShow: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (comments.length === 0) return null;
  const staged = comments.filter((comment) => comment.staged).length;
  return (
    <div className="shrink-0 border-t border-line bg-panel">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="cursor-pointer text-sm text-fg hover:text-accent-strong"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {comments.length} comment{comments.length === 1 ? "" : "s"} for the agent
          {staged > 0 && ` (${staged} in the composer)`}
        </button>
        <span className="flex-1" />
        {staged < comments.length && (
          <Button variant="secondary" size="sm" onClick={onStage}>
            <MessageSquarePlus />
            Add to composer
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSend();
            } finally {
              setBusy(false);
            }
          }}
        >
          <Send />
          Send now
        </Button>
      </div>
      {open && (
        <ul className="max-h-48 overflow-y-auto px-3 pb-2">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className="flex items-start gap-2 border-t border-line py-1.5 text-sm"
            >
              <button
                type="button"
                className="shrink-0 cursor-pointer font-mono text-xs text-accent-strong hover:underline"
                onClick={() => onShow(comment.path)}
              >
                {comment.path}:{comment.line}
                {comment.side === "old" ? " (old)" : ""}
              </button>
              <span className="min-w-0 flex-1 truncate text-fg">{comment.body}</span>
              <button
                type="button"
                aria-label={`Delete comment on ${comment.path} line ${comment.line}`}
                className="cursor-pointer rounded p-0.5 text-muted hover:text-fail"
                onClick={() => onDelete(comment.id)}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Changes tab (R8): a scope picker, the changed files, one file's diff, and comments for the worker. */
function ChangesTab({ workspace }: { workspace: Workspace }) {
  const api = useApi();
  const [summary, setSummary] = useState<ChangesSummary | undefined>();
  const [scope, setScope] = useState<ChangeScopeKind>("uncommitted");
  const [record, setRecord] = useState<string | undefined>();
  const [files, setFiles] = useState<ChangedFileList | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [diff, setDiff] = useState<FileDiff | undefined>();
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [split, setSplit] = useStoredFlag("pi-spore.changes.split", false);
  /** Bumped to reload the files and the open diff. */
  const [generation, setGeneration] = useState(0);
  const base = `changes/workspaces/${workspace.id}`;

  const query = useMemo(() => {
    const params = new URLSearchParams({ scope });
    if (scope === "record" && record) params.set("record", record);
    return params;
  }, [scope, record]);
  const ready = scope !== "record" || record !== undefined;

  useEffect(() => {
    void generation;
    api
      .get(base)
      .then((body) => setSummary(parse(ChangesSummary, body, "changes summary")))
      .catch((caught: unknown) => setError(message(caught)));
  }, [api, base, generation]);

  useEffect(() => {
    void generation;
    if (!ready) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    api
      .get(`${base}/files?${query}`)
      .then((body) => {
        if (!live) return;
        const list = parse(ChangedFileList, body, "changed files");
        setFiles(list);
        setSelected((current) =>
          current && list.files.some((file) => file.path === current)
            ? current
            : list.files[0]?.path,
        );
      })
      .catch((caught: unknown) => live && setError(message(caught)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [api, base, query, ready, generation]);

  useEffect(() => {
    void generation;
    setDiff(undefined);
    if (!selected || !ready) return;
    let live = true;
    const params = new URLSearchParams(query);
    params.set("path", selected);
    api
      .get(`${base}/diff?${params}`)
      .then((body) => {
        if (live) setDiff(parse(DiffList, body, "diff").diffs[0]);
      })
      .catch((caught: unknown) => live && setError(message(caught)));
    return () => {
      live = false;
    };
  }, [api, base, query, selected, ready, generation]);

  useEffect(() => {
    let live = true;
    let newer = false;
    // The socket sends a snapshot to the first listener of a topic only, so load the comments here too. An event
    // that comes first is newer than the load.
    api
      .get(`${base}/comments`)
      .then((body) => {
        if (live && !newer) setComments(parse(DiffCommentList, body, "comments").comments);
      })
      .catch((caught: unknown) => live && setError(message(caught)));
    const unsubscribe = api.subscribe(`changes:${workspace.id}`, (raw) => {
      const event = parse(ChangesEvent, raw, "changes event");
      if (event.type === "comments") {
        newer = true;
        setComments(event.comments);
      } else setGeneration((value) => value + 1);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api, base, workspace.id]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  const addComment = async (side: CommentSide, line: number, code: string, body: string) => {
    if (!selected) return;
    try {
      await api.send("POST", `${base}/comments`, { path: selected, side, line, code, body });
      const list = parse(DiffCommentList, await api.get(`${base}/comments`), "comments");
      setComments(list.comments);
    } catch (caught) {
      setError(message(caught));
      throw caught;
    }
  };

  const deleteComment = (id: string) => {
    api
      .send("DELETE", `changes/comments/${id}`)
      .then(() => setComments((current) => current.filter((comment) => comment.id !== id)))
      .catch((caught: unknown) => setError(message(caught)));
  };

  const stageAll = () => {
    api
      .send("POST", `${base}/comments/stage`, { staged: true })
      .then((body) => setComments(parse(DiffCommentList, body, "comments").comments))
      .catch((caught: unknown) => setError(message(caught)));
  };

  const send = async () => {
    setNote(undefined);
    try {
      const sent = parse(
        SendCommentsResponse,
        await api.send("POST", `${base}/comments/send`),
        "send",
      );
      setComments([]);
      setNote(
        `Sent ${sent.comments.length} comment${sent.comments.length === 1 ? "" : "s"} to the orchestrator chat.`,
      );
    } catch (caught) {
      setError(message(caught));
    }
  };

  const scopes = summary?.scopes ?? ["uncommitted"];
  const fileComments = comments.filter((comment) => comment.path === selected);
  const current = files?.files.find((file) => file.path === selected);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Select
          aria-label="Which changes"
          value={scope}
          onChange={(event) => {
            const next = event.target.value as ChangeScopeKind;
            setScope(next);
            if (next === "record") setRecord(summary?.records[0]?.id);
          }}
          className="w-44"
        >
          {scopes.map((kind) => (
            <option key={kind} value={kind}>
              {kind === "line" && summary?.base
                ? `Branch since ${summary.base}`
                : SCOPE_LABELS[kind]}
            </option>
          ))}
        </Select>
        {scope === "record" && (
          <Select
            aria-label="Commit"
            value={record ?? ""}
            onChange={(event) => setRecord(event.target.value || undefined)}
            className="min-w-0 flex-1"
          >
            {(summary?.records ?? []).length === 0 && <option value="">No commits</option>}
            {(summary?.records ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.shortId} {entry.subject}
              </option>
            ))}
          </Select>
        )}
        <span className="flex-1" />
        {loading && <Spinner />}
        <Tooltip label={split ? "Unified view" : "Split view"} side="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={split ? "Unified view" : "Split view"}
            onClick={() => setSplit(!split)}
          >
            {split ? <Rows3 /> : <Columns2 />}
          </Button>
        </Tooltip>
        <Tooltip label="Refresh" side="bottom">
          <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={refresh}>
            <RefreshCw />
          </Button>
        </Tooltip>
      </div>
      {error && (
        <Notice tone="fail" className="m-2">
          {error}
        </Notice>
      )}
      {note && (
        <Notice className="m-2" onClick={() => setNote(undefined)}>
          {note}
        </Notice>
      )}
      {files && files.files.length === 0 ? (
        <EmptyState icon={FileDiffIcon} title="No changes">
          {scope === "uncommitted"
            ? "The working copy matches the last commit."
            : scope === "staged"
              ? "Nothing is staged."
              : scope === "line"
                ? "The branch has no commits since its base."
                : "This commit changes no files."}
        </EmptyState>
      ) : (
        <>
          <ul
            className="max-h-[35%] shrink-0 overflow-y-auto border-b border-line py-1"
            aria-label="Changed files"
          >
            {files?.files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                selected={file.path === selected}
                comments={comments.filter((comment) => comment.path === file.path).length}
                onSelect={() => setSelected(file.path)}
              />
            ))}
            {files?.truncated && (
              <li className="px-3 py-1 text-xs text-muted">
                More files changed than the list shows.
              </li>
            )}
          </ul>
          <div className="min-h-0 flex-1 overflow-auto">
            {current && (
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                  {current.oldPath ? `${current.oldPath} → ${current.path}` : current.path}
                </span>
                <DiffCount added={current.additions} deleted={current.deletions} />
              </div>
            )}
            {diff ? (
              <DiffView
                diff={diff}
                split={split}
                comments={fileComments}
                onComment={addComment}
                onDelete={deleteComment}
              />
            ) : (
              selected && (
                <div className="flex justify-center p-6">
                  <Spinner />
                </div>
              )
            )}
          </div>
        </>
      )}
      <CommentsBar
        comments={comments}
        onDelete={deleteComment}
        onSend={send}
        onStage={stageAll}
        onShow={setSelected}
      />
    </div>
  );
}

export const changesWeb: WebModule = {
  id: "changes",
  requires: ["workspaces", "agents"],
  core: false,
  setup(host) {
    host.use(AgentsWebKey).addChatPanel("changes-comments", StagedComments);
    host.use(WorkspaceViewKey).addTab({
      id: "changes",
      title: "Changes",
      order: 0,
      wide: true,
      component: ChangesTab,
    });
  },
};
