import { ActionsKey } from "@pi-spore/mod-actions/server";
import { type ArtifactOwner, ArtifactsKey } from "@pi-spore/mod-artifacts/server";
import { QuestionsKey } from "@pi-spore/mod-attention/server";
import { CardsKey } from "@pi-spore/mod-kanban/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type BridgeCaller, bridgeCaller, type ServerModule } from "@pi-spore/module-api";
import {
  type ActionRun,
  BridgeAddCardRequest,
  type BridgeArtifactFile,
  type BridgeArtifactList,
  type BridgeCardList,
  type BridgeRunLog,
  BridgeStartCardRequest,
  BridgeUpdateCardRequest,
  BridgeWriteArtifactRequest,
  CARD_COLUMNS,
  type Card,
  type CardColumn,
  FileQuestionRequest,
  parseJsonBody,
  StartBridgeRunRequest,
} from "@pi-spore/shared";

/** Longest a request may wait for a run to change, so clients do not time out. Same as the actions routes. */
const MAX_WAIT_MS = 30_000;
/** The log tail an agent gets: enough for the errors, small enough for a model's context. */
const LOG_TAIL = 16 * 1024;

const ENDED = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/** The last `LOG_TAIL` characters, starting at a line. */
export function tail(text: string): { text: string; truncated: boolean } {
  if (text.length <= LOG_TAIL) return { text, truncated: false };
  const cut = text.slice(-LOG_TAIL);
  const newline = cut.indexOf("\n");
  return { text: newline === -1 ? cut : cut.slice(newline + 1), truncated: true };
}

/**
 * The server side of spore-bridge (architecture 2): routes under `/api/bridge/` that agents call with their own
 * token. Every route acts for the calling agent and its workspace only. Mutating calls carry the tool call id as
 * their Idempotency-Key, which the server scopes to the agent (receipts, R16.3).
 */
export const bridgeModule: ServerModule = {
  id: "bridge",
  requires: ["workspaces", "attention", "actions", "kanban", "artifacts"],
  core: false,
  setup(host) {
    const workspaces = host.use(WorkspacesKey);
    const questions = host.use(QuestionsKey);
    const actions = host.use(ActionsKey);
    const cards = host.use(CardsKey);
    const artifacts = host.use(ArtifactsKey);

    /** A run of the caller's workspace. Other workspaces' runs look like they do not exist. */
    const ownRun = (caller: BridgeCaller, id: string): ActionRun => {
      const run = actions.get(id);
      if (run.workspaceId !== caller.workspaceId)
        throw new ApiError(404, "run_not_found", `No action run ${id}`);
      return run;
    };

    /** A side chat changes nothing (ADR 0033); the tools leave it out, and the routes refuse it as well. */
    const refuseReadOnly = (caller: BridgeCaller, what: string) => {
      if (caller.readOnly)
        throw new ApiError(403, "read_only_chat", `A side chat is read-only and cannot ${what}`);
    };

    const projectOf = (caller: BridgeCaller) => workspaces.get(caller.workspaceId).projectId;

    /** A card of the caller's project. Other cards look like they do not exist (ADR 0100). */
    const ownCard = (caller: BridgeCaller, id: string): Card => {
      const card = cards.get(id);
      if (card.projectId !== projectOf(caller))
        throw new ApiError(404, "card_not_found", `No card ${id}`);
      return card;
    };

    const blockers = (caller: BridgeCaller, ids: readonly string[] | undefined) =>
      ids?.map((id) => ({ kind: "card" as const, id: ownCard(caller, id).id }));

    const author = (caller: BridgeCaller) => ({
      agentId: caller.agentId,
      workspaceId: caller.workspaceId,
    });

    host.routes.get("/cards", (c) => {
      const caller = bridgeCaller(c);
      const projectId = projectOf(caller);
      const label = c.req.query("label");
      const column = c.req.query("column");
      if (column !== undefined && !(CARD_COLUMNS as readonly string[]).includes(column))
        throw new ApiError(400, "bad_query", `"column" must be one of ${CARD_COLUMNS.join(", ")}`);
      const body: BridgeCardList = {
        cards: cards.list({
          projectId,
          ...(label ? { label } : {}),
          ...(column ? { column: column as CardColumn } : {}),
        }),
        workspaces: workspaces.list({ projectId, state: "active" }).map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          current: workspace.id === caller.workspaceId,
        })),
      };
      return c.json(body);
    });

    host.routes.post("/cards", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "change cards");
      const request = parseJsonBody(BridgeAddCardRequest, await c.req.text(), "card");
      const { blockedBy: ids, ...fields } = request;
      const blockedBy = blockers(caller, ids);
      const card = await cards.create(
        { ...fields, projectId: projectOf(caller), ...(blockedBy ? { blockedBy } : {}) },
        author(caller),
      );
      return c.json({ card }, 201);
    });

    host.routes.post("/cards/:id", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "change cards");
      const request = parseJsonBody(BridgeUpdateCardRequest, await c.req.text(), "card change");
      const card = ownCard(caller, c.req.param("id"));
      const { blockedBy: ids, ...fields } = request;
      const blockedBy = blockers(caller, ids);
      const changed = await cards.update(
        card.id,
        { ...fields, ...(blockedBy ? { blockedBy } : {}) },
        author(caller),
      );
      return c.json({ card: changed });
    });

    host.routes.post("/cards/:id/start", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "start work");
      const request = parseJsonBody(BridgeStartCardRequest, await c.req.text(), "start request");
      const approval = cards.requestStart(caller, c.req.param("id"), request);
      return c.json({ approval }, 201);
    });

    /** The folder of a scope: always the caller's own workspace or its project, never one the request names. */
    const artifactOwner = (caller: BridgeCaller, scope: string): ArtifactOwner => {
      if (scope === "workspace") return { scope, id: caller.workspaceId };
      if (scope === "project") return { scope, id: projectOf(caller) };
      throw new ApiError(400, "bad_query", '"scope" must be workspace or project');
    };

    host.routes.get("/artifacts", async (c) => {
      const caller = bridgeCaller(c);
      const body: BridgeArtifactList = {
        workspace: await artifacts.list(artifactOwner(caller, "workspace")),
        project: await artifacts.list(artifactOwner(caller, "project")),
      };
      return c.json(body);
    });

    host.routes.get("/artifacts/file", async (c) => {
      const caller = bridgeCaller(c);
      const owner = artifactOwner(caller, c.req.query("scope") ?? "");
      const { info, bytes } = await artifacts.read(owner, c.req.query("path") ?? "");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ApiError(
          415,
          "not_text",
          `${info.path} is not a text file; the user can open it in the Artifacts tab`,
        );
      }
      const body: BridgeArtifactFile = { artifact: info, content };
      return c.json(body);
    });

    host.routes.post("/artifacts", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "write artifacts");
      const request = parseJsonBody(BridgeWriteArtifactRequest, await c.req.text(), "artifact");
      const artifact = await artifacts.write(
        artifactOwner(caller, request.scope),
        request.path,
        request.content,
        caller.agentId,
      );
      return c.json({ artifact });
    });

    host.routes.post("/questions", async (c) => {
      const caller = bridgeCaller(c);
      const request = parseJsonBody(FileQuestionRequest, await c.req.text(), "question");
      return c.json({ question: questions.file(caller, request) }, 201);
    });

    host.routes.post("/runs", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "run actions");
      const request = parseJsonBody(StartBridgeRunRequest, await c.req.text(), "run request");
      const workspace = workspaces.get(caller.workspaceId);
      if (workspace.state !== "active") {
        throw new ApiError(
          409,
          "workspace_not_active",
          `The workspace is ${workspace.state}; actions run only in active workspaces`,
        );
      }
      return c.json({ run: await actions.start(workspace.id, request.action, "agent") }, 201);
    });

    /** `?wait=<ms>` answers when the run ends or the time is up. */
    host.routes.get("/runs/:id", async (c) => {
      const caller = bridgeCaller(c);
      const raw = c.req.query("wait");
      if (raw !== undefined && !/^\d{1,15}$/.test(raw))
        throw new ApiError(400, "bad_query", '"wait" must be a non-negative integer');
      const wait = Math.min(Number(raw ?? 0), MAX_WAIT_MS);
      let run = ownRun(caller, c.req.param("id"));
      if (wait > 0 && !ENDED.has(run.status)) {
        let timer: NodeJS.Timeout | undefined;
        run = await Promise.race([
          actions.wait(run.id),
          new Promise<ActionRun>((resolve) => {
            timer = setTimeout(() => resolve(actions.get(run.id)), wait);
          }),
        ]);
        clearTimeout(timer);
      }
      return c.json({ run });
    });

    host.routes.get("/runs/:id/log", async (c) => {
      const caller = bridgeCaller(c);
      const run = ownRun(caller, c.req.param("id"));
      const log = await actions.readLog(run.id, undefined);
      const cut = tail(log.text);
      const body: BridgeRunLog = {
        run: log.run,
        text: cut.text,
        truncated: cut.truncated || log.start > 0,
      };
      return c.json(body);
    });

    host.routes.post("/runs/:id/cancel", (c) => {
      const caller = bridgeCaller(c);
      return c.json({ run: actions.cancel(ownRun(caller, c.req.param("id")).id) });
    });
  },
};
