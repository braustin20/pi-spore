import { ActionsKey } from "@pi-spore/mod-actions/server";
import { type ArtifactOwner, ArtifactsKey } from "@pi-spore/mod-artifacts/server";
import { QuestionsKey } from "@pi-spore/mod-attention/server";
import { CardsKey } from "@pi-spore/mod-kanban/server";
import { PipelinesKey } from "@pi-spore/mod-pipelines/server";
import { RunsKey } from "@pi-spore/mod-runs/server";
import { WorkspacesKey } from "@pi-spore/mod-workspaces/server";
import { ApiError, type BridgeCaller, bridgeCaller, type ServerModule } from "@pi-spore/module-api";
import {
  type ActionRun,
  AnswerLaneRequest,
  AskCoordinatorRequest,
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
  MergeLaneRequest,
  OpenRunPrRequest,
  parseJsonBody,
  ReviseLaneRequest,
  StageReport,
  StartBridgeRunRequest,
  StartLaneRequest,
  slugify,
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
  requires: ["workspaces", "attention", "actions", "kanban", "artifacts", "pipelines", "runs"],
  core: false,
  setup(host) {
    const workspaces = host.use(WorkspacesKey);
    const questions = host.use(QuestionsKey);
    const actions = host.use(ActionsKey);
    const cards = host.use(CardsKey);
    const artifacts = host.use(ArtifactsKey);
    const pipelines = host.use(PipelinesKey);
    const runs = host.use(RunsKey);

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

    /** ADR 0154: a run's coordinator lists and adds cards; the user changes and starts them. */
    const refuseCoordinator = (caller: BridgeCaller) => {
      if (runs.runOf(caller.workspaceId))
        throw new ApiError(
          403,
          "run_coordinator",
          "A run's coordinator only lists and adds cards; the user changes and starts them",
        );
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
      // ADR 0154: a coordinator's card waits in the backlog, marked with its run, until the user moves it.
      const run = runs.runOf(caller.workspaceId);
      if (run) {
        const label = `from-run:${slugify(workspaces.get(run.workspaceId).name, 31)}`;
        fields.column = "backlog";
        if (!fields.labels?.includes(label)) fields.labels = [...(fields.labels ?? []), label];
      }
      const card = await cards.create(
        { ...fields, projectId: projectOf(caller), ...(blockedBy ? { blockedBy } : {}) },
        author(caller),
      );
      return c.json({ card }, 201);
    });

    host.routes.post("/cards/:id", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "change cards");
      refuseCoordinator(caller);
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
      refuseCoordinator(caller);
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
      if (runs.laneOf(caller.workspaceId)) {
        throw new ApiError(
          409,
          "ask_coordinator",
          "Agents in a run ask their coordinator: use ask_coordinator",
        );
      }
      return c.json({ question: questions.file(caller, request) }, 201);
    });

    host.routes.post("/lanes", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "start lanes");
      const request = parseJsonBody(StartLaneRequest, await c.req.text(), "lane");
      return c.json({ lane: await runs.startLane(caller, request) }, 201);
    });

    host.routes.post("/lanes/revise", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "revise lanes");
      const request = parseJsonBody(ReviseLaneRequest, await c.req.text(), "lane revision");
      return c.json({ lane: await runs.reviseLane(caller, request) });
    });

    host.routes.post("/lanes/merge", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "merge lanes");
      const request = parseJsonBody(MergeLaneRequest, await c.req.text(), "lane merge");
      return c.json({ lane: await runs.mergeLane(caller, request) });
    });

    host.routes.post("/coordinator/pr", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "open the run's PR");
      const request = parseJsonBody(OpenRunPrRequest, await c.req.text(), "run PR request");
      return c.json({ approval: runs.requestPr(caller, request) }, 201);
    });

    // Lane reviewers are read-only and may ask their coordinator, so this route does not refuse read-only callers.
    host.routes.post("/coordinator/questions", async (c) => {
      const caller = bridgeCaller(c);
      const request = parseJsonBody(AskCoordinatorRequest, await c.req.text(), "question");
      return c.json({ question: runs.askCoordinator(caller, request) }, 201);
    });

    host.routes.post("/coordinator/answers", async (c) => {
      const caller = bridgeCaller(c);
      refuseReadOnly(caller, "answer lanes");
      const request = parseJsonBody(AnswerLaneRequest, await c.req.text(), "answer");
      return c.json({ question: runs.answerLane(caller, request) });
    });

    // It only reads, so lane reviewers and side chats may call it.
    host.routes.get("/run-status/:id", (c) =>
      c.json({ status: runs.status(bridgeCaller(c), c.req.param("id")) }),
    );

    // Reviewers are read-only and report too, so this route does not refuse read-only callers.
    host.routes.post("/reports", async (c) => {
      const caller = bridgeCaller(c);
      const request = parseJsonBody(StageReport, await c.req.text(), "report");
      return c.json(await pipelines.report(caller, request));
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
      refuseReadOnly(caller, "cancel actions");
      return c.json({ run: actions.cancel(ownRun(caller, c.req.param("id")).id) });
    });
  },
};
