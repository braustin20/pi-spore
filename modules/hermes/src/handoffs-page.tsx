/**
 * Hermes handoffs on the Hermes page, and the workspace Details panel (card Hermes 1.2). The chat page (card Hermes
 * 2.1, `chat-page.tsx`) shows `Handoffs` when no session is open, and reuses `ControlRow` and `Reconcile`.
 */
import { useApi } from "@pi-spore/module-api";
import {
  type HermesControl,
  HermesHandoff,
  type HermesHandoffState,
  HermesReconcile,
  type HermesRunFacts,
  ProjectList,
  parse,
  type Workspace,
  WorkspaceList,
} from "@pi-spore/shared";
import {
  Button,
  Chip,
  CollapsibleSection,
  EmptyState,
  Input,
  Notice,
  Panel,
  PanelHeader,
  type Tone,
  useConfirm,
} from "@pi-spore/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import Type from "typebox";

const STATE_TONE: Record<HermesHandoffState, Tone> = {
  pending: "warn",
  accepted: "neutral",
  running: "neutral",
  completed: "ok",
  cancelled: "neutral",
  failed: "fail",
  uncertain: "warn",
};
const ENDED = new Set<HermesHandoffState>(["completed", "cancelled", "failed", "uncertain"]);
/** How often the workspace panel reads its handoffs again. The list is local, so this sends Hermes nothing. */
export const REFRESH_MS = 5_000;

/** `GET /api/hermes/handoffs`. `enabled` false: Hermes is off, and the list is empty. */
const HandoffList = Type.Object({ enabled: Type.Boolean(), handoffs: Type.Array(HermesHandoff) });
const time = (ms: number) => new Date(ms).toLocaleString();
const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** One approval or clarify question. Only an open one takes an answer; the server posts it to Hermes once. */
export function ControlRow({
  control,
  answer,
}: {
  control: HermesControl;
  answer: (body: { choice: "once" | "deny" } | { answer: string }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const sending = useRef(false);
  const send = async (body: { choice: "once" | "deny" } | { answer: string }) => {
    // A double click sends one request; the server refuses a second one anyway.
    if (sending.current) return;
    sending.current = true;
    try {
      await answer(body);
    } finally {
      sending.current = false;
    }
  };
  const expired = control.state === "expired" || Date.now() > control.expiresAt;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={control.state === "open" && !expired ? "warn" : "neutral"}>
          {expired && control.state === "open" ? "expired" : control.state}
        </Chip>
        <span className="font-medium">
          {control.kind === "approval" ? "Hermes asks to run a command" : "Hermes asks a question"}
        </span>
      </div>
      {(control.command ?? control.question) && (
        <code className="break-words">{control.command ?? control.question}</code>
      )}
      {control.description && <span className="text-muted">{control.description}</span>}
      {control.state === "open" && !expired && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Expires {time(control.expiresAt)}.</span>
          {control.kind === "approval" ? (
            <>
              <Button size="sm" onClick={() => void send({ choice: "once" })}>
                Allow once
              </Button>
              <Button size="sm" variant="danger" onClick={() => void send({ choice: "deny" })}>
                Deny
              </Button>
            </>
          ) : (
            <>
              <Input
                aria-label="Answer"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <Button size="sm" disabled={!text} onClick={() => void send({ answer: text })}>
                Answer
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A request from Hermes that waits for the user's yes (card Hermes 1.3). Only this page decides it: the routes take the
 * user token, never an agent's.
 */
function RequestDecision({
  decide,
}: {
  decide: (action: "accept" | "decline", body: { reason?: string }) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted">
        Accept gives it to the workspace's chat as input from a remote agent, not as your approval.
      </span>
      <Button size="sm" onClick={() => void decide("accept", {})}>
        Accept
      </Button>
      <Input
        aria-label="Reason to decline"
        placeholder="Reason (optional)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        size="sm"
        variant="danger"
        onClick={() => void decide("decline", reason.trim() ? { reason: reason.trim() } : {})}
      >
        Decline
      </Button>
    </div>
  );
}

/**
 * The facts of a run Hermes lost track of, then the user's pick. Nothing is picked for the user. "Mark as interrupted"
 * is always there; `more` adds "Send again" and "Drop" (handoffs). A chat run gets neither: its session waits until
 * the lost run is resolved.
 */
export function Reconcile({
  load,
  act,
  more,
}: {
  load: () => Promise<HermesRunFacts>;
  act: (body: unknown) => Promise<void>;
  more: boolean;
}) {
  const { confirm, dialog } = useConfirm();
  const [facts, setFacts] = useState<HermesRunFacts | undefined>();
  const [error, setError] = useState<string | undefined>();
  const check = () => {
    setError(undefined);
    load()
      .then(setFacts)
      .catch((caught: unknown) => setError(message(caught)));
  };
  const resend = async () => {
    const yes = await confirm({
      title: "Send again?",
      message:
        "The first run may have run, in part or in full. Its side effects are not undone. Send the same text to Hermes as a new handoff?",
      confirmLabel: "Send again",
      tone: "danger",
    });
    if (yes) await act({ action: "resend", confirmed: true });
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      {dialog}
      {error && <Notice tone="fail">{error}</Notice>}
      {!facts ? (
        <div>
          <Button size="sm" onClick={check}>
            Check what is known
          </Button>
        </div>
      ) : (
        <>
          <ul className="m-0 flex flex-col gap-1 pl-4">
            <li>Run status now: {facts.runStatus}</li>
            <li>Last tool started: {facts.toolStarted ?? "none seen"}</li>
            <li>Last tool finished: {facts.toolFinished ?? "none seen"}</li>
            {facts.messages.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: messages have no stable id here and never reorder.
              <li key={index}>
                {entry.role}
                {entry.tool ? ` (${entry.tool})` : ""}: {entry.content ?? ""}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void act({ action: "interrupt" })}>
              Mark as interrupted
            </Button>
            {more && (
              <>
                <Button size="sm" onClick={() => void resend()}>
                  Send again
                </Button>
                <Button size="sm" onClick={() => void act({ action: "drop" })}>
                  Drop
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The workspace's handoffs in its Details column, with a link to the Hermes handoffs page, where Cancel and the full
 * result are. It shows nothing for a workspace that never asked Hermes, so with Hermes off it is never there.
 */
export function HermesPanel({
  workspace,
  onLoaded,
}: {
  workspace: Workspace;
  onLoaded: () => void;
}) {
  const api = useApi();
  const [handoffs, setHandoffs] = useState<HermesHandoff[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    const read = () =>
      api
        .get(`hermes/handoffs?workspaceId=${encodeURIComponent(workspace.id)}`)
        .then((body) => {
          setHandoffs(parse(HandoffList, body, "Hermes handoffs").handoffs);
          setError(undefined);
        })
        .catch((caught: unknown) => setError(message(caught)));
    void read();
    // A chat may ask Hermes while Details is open; the panel then appears without a reload.
    const timer = setInterval(read, REFRESH_MS);
    return () => clearInterval(timer);
  }, [api, workspace.id]);
  useEffect(() => {
    if (handoffs !== undefined || error !== undefined) onLoaded();
  }, [handoffs, error, onLoaded]);
  if (!error && !handoffs?.length) return null;
  return (
    <CollapsibleSection title="Hermes handoffs">
      <div className="flex flex-col gap-2 text-sm">
        {error && <Notice tone="fail">{error}</Notice>}
        {handoffs?.slice(0, 5).map((handoff) => (
          <div key={handoff.id} className="flex min-w-0 items-center gap-2">
            <Chip tone={STATE_TONE[handoff.state]}>{handoff.state}</Chip>
            <span className="min-w-0 truncate">{handoff.title ?? handoff.text}</span>
          </div>
        ))}
        <a href="#/hermes" className="text-accent">
          Open the Hermes page
        </a>
      </div>
    </CollapsibleSection>
  );
}

/**
 * Handoffs from Pi chats to Hermes (card Hermes 1.2) and requests from Hermes (card Hermes 1.3), on the Hermes page
 * that Home items and Details link to.
 */
export function Handoffs() {
  const api = useApi();
  const [handoffs, setHandoffs] = useState<HermesHandoff[] | undefined>();
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | undefined>();
  /** "<project> / <workspace>" by workspace id, for the target of each request from Hermes. */
  const [targets, setTargets] = useState<ReadonlyMap<string, string>>(new Map());
  const load = useCallback(() => {
    api
      .get("hermes/handoffs")
      .then(async (body) => {
        const list = parse(HandoffList, body, "Hermes handoffs");
        setEnabled(list.enabled);
        setHandoffs(list.handoffs);
        if (!list.handoffs.some((handoff) => handoff.direction === "in")) return;
        const [{ workspaces }, { projects }] = await Promise.all([
          api.get("workspaces").then((answer) => parse(WorkspaceList, answer, "workspaces")),
          api.get("projects").then((answer) => parse(ProjectList, answer, "projects")),
        ]);
        const project = new Map(projects.map((entry) => [entry.id, entry.name]));
        setTargets(
          new Map(
            workspaces.map((entry) => [
              entry.id,
              `${project.get(entry.projectId) ?? entry.projectId} / ${entry.name}`,
            ]),
          ),
        );
      })
      .catch((caught: unknown) => setError(message(caught)));
  }, [api]);
  useEffect(load, [load]);
  const send = async (path: string, body: unknown) => {
    setError(undefined);
    try {
      await api.send("POST", path, body);
    } catch (caught) {
      setError(message(caught));
    }
    load();
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-base font-semibold">Handoffs</h2>
        <Button size="sm" onClick={load}>
          Reload
        </Button>
      </div>
      {error && <Notice tone="fail">{error}</Notice>}
      {!enabled && (
        <Notice>
          Hermes is off. Turn it on with <code>hermes.enabled</code> on the{" "}
          <a href="#/settings" className="text-accent">
            Settings
          </a>{" "}
          page.
        </Notice>
      )}
      {enabled && handoffs?.length === 0 && <EmptyState title="No Hermes handoffs yet." />}
      {handoffs?.map((handoff) => (
        <Panel key={handoff.id}>
          <PanelHeader
            title={`${handoff.direction === "in" ? "From Hermes: " : ""}${handoff.title ?? `${handoff.kind} ${handoff.id}`}`}
          />
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={STATE_TONE[handoff.state]}>{handoff.state}</Chip>
              {handoff.resolution && <Chip tone="neutral">{handoff.resolution}</Chip>}
              <span className="text-muted">
                Asked {time(handoff.createdAt)}, changed {time(handoff.updatedAt)}.
                {handoff.direction === "out" &&
                  ` Provider ${handoff.provider ?? "unknown"}, model ${handoff.model ?? "unknown"}.`}
              </span>
              {handoff.direction === "out" && !ENDED.has(handoff.state) && (
                <Button
                  size="sm"
                  onClick={() => void send(`hermes/handoffs/${handoff.id}/cancel`, {})}
                >
                  Cancel
                </Button>
              )}
            </div>
            {handoff.direction === "in" && (
              <span>
                For <strong>{targets.get(handoff.workspaceId) ?? handoff.workspaceId}</strong>, from
                the Hermes profile {handoff.profile}, request {handoff.requestId}.
              </span>
            )}
            <p className="m-0 break-words whitespace-pre-wrap">{handoff.text}</p>
            {handoff.direction === "in" && handoff.state === "pending" && (
              <RequestDecision
                decide={(action, body) => send(`hermes/handoffs/${handoff.id}/${action}`, body)}
              />
            )}
            {handoff.direction === "out" && handoff.state === "pending" && handoff.error && (
              <Notice tone="warn">{handoff.error}</Notice>
            )}
            {handoff.controls.map((control) => (
              <ControlRow
                key={control.promptId}
                control={control}
                answer={(body) =>
                  send(
                    `hermes/handoffs/${handoff.id}/controls/${encodeURIComponent(control.promptId)}`,
                    body,
                  )
                }
              />
            ))}
            {handoff.result && (
              <pre className="m-0 max-h-80 overflow-auto rounded-md bg-raised p-2 whitespace-pre-wrap">
                {handoff.result}
              </pre>
            )}
            {(handoff.direction === "in" || handoff.state !== "pending") && handoff.error && (
              <Notice tone="fail">{handoff.error}</Notice>
            )}
            {handoff.state === "uncertain" && !handoff.resolution && (
              <Reconcile
                more
                load={async () =>
                  parse(
                    HermesReconcile,
                    await api.get(`hermes/handoffs/${handoff.id}/reconcile`),
                    "Hermes reconcile",
                  )
                }
                act={(body) => send(`hermes/handoffs/${handoff.id}/resolve`, body)}
              />
            )}
            {handoff.resentAs && (
              <span className="text-muted">Sent again as {handoff.resentAs}.</span>
            )}
          </div>
        </Panel>
      ))}
    </section>
  );
}
