import { useApi } from "@pi-spore/module-api";
import { Agent, ChangesEvent, type DiffComment, DiffCommentList, parse } from "@pi-spore/shared";
import { Button, Panel } from "@pi-spore/ui";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Type } from "typebox";

const AgentResponse = Type.Object({ agent: Agent });

/**
 * The comments staged for a chat's next message (R8.3), above its composer. The server adds them to the next message
 * typed in the workspace's active orchestrator chat. A drop only takes a comment out of the batch; it stays open in
 * Changes.
 */
export function StagedComments({ chatId }: { chatId: string }) {
  const api = useApi();
  const [workspaceId, setWorkspaceId] = useState<string | undefined>();
  const [staged, setStaged] = useState<DiffComment[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    api
      .get(`agents/${chatId}`)
      .then((body) => {
        const { agent } = parse(AgentResponse, body, "agent");
        if (live && agent.kind === "worker") setWorkspaceId(agent.workspaceId);
      })
      .catch((caught: unknown) => live && setError(String(caught)));
    return () => {
      live = false;
    };
  }, [api, chatId]);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    let newer = false;
    // Load the open comments on mount too, while the socket may still be connecting. An event that comes first is
    // newer than the load.
    api
      .get(`changes/workspaces/${workspaceId}/comments`)
      .then((body) => {
        const { comments } = parse(DiffCommentList, body, "comments");
        if (live && !newer) setStaged(comments.filter((comment) => comment.staged));
        if (live) setError(undefined);
      })
      .catch((caught: unknown) => live && setError(String(caught)));
    const unsubscribe = api.subscribe(`changes:${workspaceId}`, (raw) => {
      const event = parse(ChangesEvent, raw, "changes event");
      if (event.type !== "comments") return;
      newer = true;
      setStaged(event.comments.filter((comment) => comment.staged));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api, workspaceId]);

  const drop = (ids?: string[]) => {
    api
      .send("POST", `changes/workspaces/${workspaceId}/comments/stage`, {
        staged: false,
        ...(ids ? { ids } : {}),
      })
      .then((body) => {
        const { comments } = parse(DiffCommentList, body, "comments");
        setStaged(comments.filter((comment) => comment.staged));
        setError(undefined);
      })
      .catch((caught: unknown) => setError(String(caught)));
  };

  if (staged.length === 0 && !error) return null;
  if (staged.length === 0)
    return (
      <Panel aria-label="Comments for the next message" className="mb-3">
        <p className="m-0 text-sm text-fail">{error}</p>
      </Panel>
    );
  return (
    <Panel aria-label="Comments for the next message" className="mb-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-sm">
          <span className="flex-1 font-semibold">
            {staged.length} diff comment{staged.length === 1 ? "" : "s"} will go with your next
            message
          </span>
          <Button size="sm" variant="ghost" onClick={() => drop()}>
            Drop all
          </Button>
        </div>
        {error && <p className="m-0 text-sm text-fail">{error}</p>}
        <ul className="m-0 flex max-h-32 list-none flex-col gap-1 overflow-y-auto p-0">
          {staged.map((comment) => (
            <li key={comment.id} className="flex items-start gap-2 text-sm">
              <code className="shrink-0 text-xs text-accent-strong">
                {comment.path}:{comment.line}
              </code>
              <span className="min-w-0 flex-1 truncate">{comment.body}</span>
              <button
                type="button"
                aria-label={`Drop comment on ${comment.path} line ${comment.line}`}
                className="cursor-pointer rounded p-0.5 text-muted hover:text-fail"
                onClick={() => drop([comment.id])}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
