import { SettingsPageKey } from "@pi-spore/mod-projects/web";
import { WorkspaceViewKey } from "@pi-spore/mod-workspaces/web";
import { useApi, type WebModule } from "@pi-spore/module-api";
import {
  type HermesControl,
  HermesHandoff,
  type HermesHandoffState,
  HermesReconcile,
  HermesStatus,
  parse,
  type Workspace,
} from "@pi-spore/shared";
import {
  Button,
  Chip,
  CollapsibleSection,
  EmptyState,
  Input,
  Notice,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  type Tone,
  useConfirm,
} from "@pi-spore/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import Type from "typebox";

const TONE: Record<HermesStatus["state"], Tone> = {
  disabled: "neutral",
  unreachable: "warn",
  unauthorized: "fail",
  incompatible: "fail",
  ready: "ok",
};

/** One row on the Settings page with the connector's status (ADR 0202). The key never reaches the browser. */
export function HermesSection() {
  const api = useApi();
  const [status, setStatus] = useState<HermesStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const show = useCallback((answer: Promise<unknown>) => {
    setError(undefined);
    answer
      .then((body) => setStatus(parse(HermesStatus, body, "Hermes status")))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, []);
  useEffect(() => show(api.get("hermes/status")), [api, show]);

  return (
    <Panel>
      <PanelHeader title="Hermes" />
      <div className="flex flex-col gap-2">
        {error && <Notice tone="fail">{error}</Notice>}
        {!status && !error && <p className="m-0 text-muted">Loading...</p>}
        {status && (
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={TONE[status.state]}>{status.state}</Chip>
            <span className="min-w-0 flex-1 text-sm break-words">
              {status.state === "disabled" && "Off. Set hermes.enabled to true to connect."}
              {status.state === "ready" &&
                `Hermes ${status.version} at ${status.url}, profile ${status.profile}.`}
              {"detail" in status && status.detail}
            </span>
            <Button size="sm" onClick={() => show(api.send("POST", "hermes/refresh"))}>
              Reload
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

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
const HandoffList = Type.Object({ handoffs: Type.Array(HermesHandoff) });
const time = (ms: number) => new Date(ms).toLocaleString();
const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** One approval or clarify question. Only an open one takes an answer; the server posts it to Hermes once. */
function ControlRow({
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

/** The facts of an uncertain handoff, then the user's pick. Nothing is picked for the user. */
function Reconcile({
  handoff,
  act,
}: {
  handoff: HermesHandoff;
  act: (body: unknown) => Promise<void>;
}) {
  const api = useApi();
  const { confirm, dialog } = useConfirm();
  const [facts, setFacts] = useState<HermesReconcile | undefined>();
  const [error, setError] = useState<string | undefined>();
  const check = () => {
    setError(undefined);
    api
      .get(`hermes/handoffs/${handoff.id}/reconcile`)
      .then((body) => setFacts(parse(HermesReconcile, body, "Hermes reconcile")))
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
            <Button size="sm" onClick={() => void resend()}>
              Send again
            </Button>
            <Button size="sm" onClick={() => void act({ action: "drop" })}>
              Drop
            </Button>
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
    api
      .get(`hermes/handoffs?workspaceId=${encodeURIComponent(workspace.id)}`)
      .then((body) => setHandoffs(parse(HandoffList, body, "Hermes handoffs").handoffs))
      .catch((caught: unknown) => setError(message(caught)));
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
          Open the Hermes handoffs page
        </a>
      </div>
    </CollapsibleSection>
  );
}

/** Handoffs from Pi chats to Hermes (card Hermes 1.2). Home items and the workspace Details panel link here. */
export function HandoffsPage() {
  const api = useApi();
  const [handoffs, setHandoffs] = useState<HermesHandoff[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(() => {
    api
      .get("hermes/handoffs")
      .then((body) => setHandoffs(parse(HandoffList, body, "Hermes handoffs").handoffs))
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
    <Page>
      <PageHeader title="Hermes handoffs">
        <Button size="sm" onClick={load}>
          Reload
        </Button>
      </PageHeader>
      {error && <Notice tone="fail">{error}</Notice>}
      {handoffs?.length === 0 && <EmptyState title="No handoffs to Hermes yet." />}
      {handoffs?.map((handoff) => (
        <Panel key={handoff.id}>
          <PanelHeader title={handoff.title ?? `${handoff.kind} ${handoff.id}`} />
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={STATE_TONE[handoff.state]}>{handoff.state}</Chip>
              {handoff.resolution && <Chip tone="neutral">{handoff.resolution}</Chip>}
              <span className="text-muted">
                Asked {time(handoff.createdAt)}, changed {time(handoff.updatedAt)}. Provider{" "}
                {handoff.provider ?? "unknown"}, model {handoff.model ?? "unknown"}.
              </span>
              {!ENDED.has(handoff.state) && (
                <Button
                  size="sm"
                  onClick={() => void send(`hermes/handoffs/${handoff.id}/cancel`, {})}
                >
                  Cancel
                </Button>
              )}
            </div>
            <p className="m-0 break-words whitespace-pre-wrap">{handoff.text}</p>
            {handoff.state === "pending" && handoff.error && (
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
            {handoff.state !== "pending" && handoff.error && (
              <Notice tone="fail">{handoff.error}</Notice>
            )}
            {handoff.state === "uncertain" && !handoff.resolution && (
              <Reconcile
                handoff={handoff}
                act={(body) => send(`hermes/handoffs/${handoff.id}/resolve`, body)}
              />
            )}
            {handoff.resentAs && (
              <span className="text-muted">Sent again as {handoff.resentAs}.</span>
            )}
          </div>
        </Panel>
      ))}
    </Page>
  );
}

export const hermesWeb: WebModule = {
  id: "hermes",
  requires: ["projects", "workspaces"],
  core: false,
  setup(host) {
    host.use(SettingsPageKey).addSection({ id: "hermes", order: 20, component: HermesSection });
    // No rail entry (ADR 0202 decision 12): Home items link here.
    host.addPage({ path: "/hermes", title: "Hermes handoffs", component: HandoffsPage });
    host.use(WorkspaceViewKey).addPanel({ id: "hermes", order: 8, component: HermesPanel });
  },
};
