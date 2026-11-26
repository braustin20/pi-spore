import { HomeItemsKey } from "@pi-spore/mod-attention/server";
import { ApiError, type ServerHost } from "@pi-spore/module-api";
import type { AnswerHermesControlRequest, HermesControl, HermesRunFacts } from "@pi-spore/shared";
import Type from "typebox";
import type { Hermes, Run } from "./contract.js";

/** How much of one session message the reconcile view shows. */
const FACT_CAP = 1_000;

export interface ControlRow {
  /** The handoff or chat run that owns the control. Both take their ids from `host.newId`, so they never clash. */
  handoff_id: string;
  prompt_id: string;
  kind: "approval" | "clarify";
  command: string | null;
  description: string | null;
  question: string | null;
  execution_generation: number;
  state: HermesControl["state"];
  created_at: number;
}

/**
 * The approvals and clarify questions a Hermes run waits on, for handoffs (card Hermes 1.2) and chat runs (card
 * Hermes 2.1) alike: one store and one answer path. Only the user answers; nothing here answers on its own.
 */
export interface Controls {
  /** `hermes.approvalTimeoutSeconds` in ms. */
  timeoutMs(): Promise<number>;
  rows(owner: string): ControlRow[];
  list(owner: string, timeout: number): HermesControl[];
  /**
   * Makes the stored controls match the run's `pending_controls`. One the run no longer waits on expires; one whose
   * answer is on its way (`answering`) too, and `answer` marks it answered when Hermes takes it.
   */
  sync(owner: string, run: Run, generation: number | null): void;
  /** Expires every open control of an owner whose run ended. Runs inside the caller's transaction. */
  expireOpen(owner: string): void;
  /**
   * Posts the user's answer once, with the exact body. A stale or timed-out control is `expired` (409
   * `control_expired`), and nothing is sent again.
   */
  answer(
    owner: string,
    runId: string,
    promptId: string,
    request: AnswerHermesControlRequest,
  ): Promise<void>;
}

const cap = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}... (cut at ${max} characters)`;

export function createControls(host: ServerHost, hermes: Hermes): Controls {
  const homeItems = host.use(HomeItemsKey);
  const { store } = host;
  const approvalSeconds = host.settings.declare({
    key: "hermes.approvalTimeoutSeconds",
    // Hermes's `approvals.timeout`; pi-spore cannot read Hermes's config, so it is set here to match.
    schema: Type.Integer({ minimum: 1 }),
    default: 300,
    scope: "global",
  });

  const rows = (owner: string) =>
    store.all<ControlRow>(
      "SELECT * FROM hermes_controls WHERE handoff_id = ? ORDER BY created_at, prompt_id",
      owner,
    );
  const setState = (owner: string, promptId: string, state: HermesControl["state"]) =>
    store.run(
      "UPDATE hermes_controls SET state = ?, updated_at = ? WHERE handoff_id = ? AND prompt_id = ?",
      state,
      host.now(),
      owner,
      promptId,
    );
  const timeoutMs = async () => (await host.settings.resolve()).get(approvalSeconds).value * 1000;

  return {
    timeoutMs,
    rows,
    list: (owner, timeout) =>
      rows(owner).map((control) => ({
        promptId: control.prompt_id,
        kind: control.kind,
        ...(control.command === null ? {} : { command: control.command }),
        ...(control.description === null ? {} : { description: control.description }),
        ...(control.question === null ? {} : { question: control.question }),
        state: control.state,
        createdAt: control.created_at,
        expiresAt: control.created_at + timeout,
      })),
    sync(owner, run, generation) {
      const pending = run.pending_controls ?? [];
      const now = host.now();
      let changed = false;
      store.transaction(() => {
        for (const control of pending) {
          const kind =
            control.kind === "clarify" || control.question !== undefined ? "clarify" : "approval";
          changed =
            store.run(
              `INSERT OR IGNORE INTO hermes_controls (handoff_id, prompt_id, kind, command, description, question,
               execution_generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
              owner,
              control.prompt_id,
              kind,
              control.command ?? null,
              control.description ?? null,
              control.question ?? null,
              run.execution_generation ?? generation ?? 0,
              now,
              now,
            ).changes > 0 || changed;
        }
        const open = new Set(pending.map((control) => control.prompt_id));
        for (const control of rows(owner))
          if (
            (control.state === "open" || control.state === "answering") &&
            !open.has(control.prompt_id)
          ) {
            setState(owner, control.prompt_id, "expired");
            changed = true;
          }
      });
      if (changed) homeItems.changed();
    },
    expireOpen(owner) {
      store.run(
        "UPDATE hermes_controls SET state = 'expired', updated_at = ? WHERE handoff_id = ? AND state = 'open'",
        host.now(),
        owner,
      );
    },
    async answer(owner, runId, promptId, request) {
      const timeout = await timeoutMs();
      const expire = () => {
        setState(owner, promptId, "expired");
        homeItems.changed();
        return new ApiError(
          409,
          "control_expired",
          "This Hermes request expired; nothing was sent",
        );
      };
      const control = rows(owner).find((entry) => entry.prompt_id === promptId);
      if (!control) throw new ApiError(404, "control_not_found", `No Hermes request ${promptId}`);
      const isApproval = "choice" in request;
      if (isApproval !== (control.kind === "approval"))
        throw new ApiError(
          400,
          "bad_answer",
          `Answer a ${control.kind} with ${control.kind === "approval" ? "choice" : "answer"}`,
        );
      if (control.state === "open" && host.now() > control.created_at + timeout) throw expire();
      // One answer posts once: only the request that moves the control out of `open` sends it.
      const { changes } = store.run(
        "UPDATE hermes_controls SET state = 'answering', updated_at = ? WHERE handoff_id = ? AND prompt_id = ? AND state = 'open'",
        host.now(),
        owner,
        promptId,
      );
      if (changes === 0)
        throw new ApiError(
          409,
          "control_expired",
          `This Hermes request is ${control.state}; nothing was sent`,
        );
      try {
        const target = { request_id: promptId, execution_generation: control.execution_generation };
        if (isApproval) await hermes.answerApproval(runId, { ...target, choice: request.choice });
        else await hermes.answerClarify(runId, { ...target, answer: request.answer });
      } catch (error) {
        // Hermes moved on: a stale generation, a request it no longer has, or a run that ended.
        if (
          error instanceof ApiError &&
          (error.status === 409 || error.status === 400 || error.status === 404)
        )
          throw expire();
        // The connector refused before sending (Hermes off, not ready, or no key): the user may answer again.
        if (
          error instanceof ApiError &&
          (error.code === "hermes_not_ready" || error.code === "hermes_key_file")
        ) {
          setState(owner, promptId, "open");
          homeItems.changed();
          throw error;
        }
        // No answer came back, yet Hermes may have taken the post. Only a run that still waits on the request may get
        // another; one that no longer does took it (or timed out). Unknown stays `answering` until the next sync.
        let waiting: boolean | undefined;
        try {
          const run = await hermes.getRun(runId);
          waiting = (run.pending_controls ?? []).some((entry) => entry.prompt_id === promptId);
        } catch {
          waiting = undefined;
        }
        if (waiting !== undefined) setState(owner, promptId, waiting ? "open" : "answered");
        homeItems.changed();
        throw error;
      }
      setState(owner, promptId, "answered");
      homeItems.changed();
    },
  };
}

/** What is known about a run Hermes lost track of, before the user picks (ADR 0202 decision 6). */
export async function runFacts(
  hermes: Hermes,
  row: {
    run_id: string | null;
    session_id: string | null;
    tool_started: string | null;
    tool_finished: string | null;
  },
): Promise<HermesRunFacts> {
  let runStatus: string;
  try {
    runStatus = row.run_id ? (await hermes.getRun(row.run_id)).status : "no run";
  } catch (error) {
    runStatus = `not readable: ${(error as Error).message}`;
  }
  let messages: HermesRunFacts["messages"] = [];
  if (row.session_id) {
    const { data } = await hermes.sessionMessages(row.session_id, { order: "latest", limit: 20 });
    messages = data.reverse().map((entry) => ({
      role: entry.role,
      ...(entry.content ? { content: cap(entry.content, FACT_CAP) } : {}),
      ...(entry.tool_name ? { tool: entry.tool_name } : {}),
    }));
  }
  return {
    runStatus,
    ...(row.tool_started ? { toolStarted: row.tool_started } : {}),
    ...(row.tool_finished ? { toolFinished: row.tool_finished } : {}),
    messages,
  };
}
