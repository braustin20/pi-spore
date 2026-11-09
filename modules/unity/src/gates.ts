import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Actions, ProvidedAction } from "@pi-spore/mod-actions/server";
import type { Agents } from "@pi-spore/mod-agents/server";
import type { Artifacts } from "@pi-spore/mod-artifacts/server";
import type { Approvals } from "@pi-spore/mod-attention/server";
import { ApiError } from "@pi-spore/module-api";
import type { UnityTestMode, UnityTestRun, Workspace } from "@pi-spore/shared";
import Type from "typebox";
import type { createEditors, UnityCommand } from "./editors.js";

/** The Unity batch-mode test gates (R10.6, ADR 0156): `unity-test-editmode` and `unity-test-playmode`. */
const MODES: UnityTestMode[] = ["EditMode", "PlayMode"];
const gateName = (mode: UnityTestMode) => `unity-test-${mode.toLowerCase()}`;
const reportPath = (runId: string) => `unity-tests/${runId}.xml`;

/** `unity test` kills Unity after this long, so a hung editor cannot hold a gate forever. */
const TEST_TIMEOUT_SECONDS = 30 * 60;
const POLL_MS = 5_000;
/** The process-side deadline: the CLI timeout plus a minute. */
export const TEST_DEADLINE_MS = (TEST_TIMEOUT_SECONDS + 60) * 1_000;

const CLOSE_KIND = "unity-close-editor";
const CloseSubject = Type.Object(
  { projectId: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** Waits for `ms`, or until `signal` aborts. */
export const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolvePause) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolvePause();
    }
  });

export interface GateDeps {
  actions: Actions;
  agents: Agents;
  approvals: Approvals;
  artifacts: Artifacts;
  editors: ReturnType<typeof createEditors>;
  unity: UnityCommand;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long `unity test` may run before pi-spore stops its process. */
  testDeadlineMs: number;
  /** Where `unity test` writes its report before it moves into the artifacts. */
  reportDir: string;
}

/** Registers the gates and the "close Unity?" approval. Returns the recent gate runs of a workspace for the panel. */
export function registerGates(deps: GateDeps): (workspace: Workspace) => Promise<UnityTestRun[]> {
  const { actions, agents, approvals, artifacts, editors } = deps;
  /** Approvals filed and not decided yet, with the subject the gate filed. */
  const filed = new Map<string, { projectId: string; path: string }>();
  /** Approvals a running gate is waiting on. */
  const attended = new Set<string>();
  /** The user's answers, for the gate that waits. */
  const answers = new Map<string, boolean>();

  approvals.register({
    kind: CLOSE_KIND,
    subject: CloseSubject,
    approve: async (subject, approval) => {
      const asked = filed.get(approval.id);
      if (asked?.projectId !== subject.projectId || asked.path !== subject.path)
        throw new ApiError(
          422,
          "subject_changed",
          "This approval is for the folder the gate asked about. Approve it as it is.",
        );
      if (!attended.has(approval.id)) return "The gate that asked has ended. Unity was not closed.";
      // The approval was filed for the user's editor. Look again: it may have gone, or an agent may hold it now.
      const state = await editors.scan(subject.projectId);
      if (!state.editors.some((editor) => editor.path === subject.path))
        return "Unity is not open on that folder any more. Nothing was closed.";
      if (state.lease?.path === subject.path && state.lease.owner === "agent")
        return "An agent has Unity open on that folder now. Nothing was closed; the gate waits for the agent.";
      await editors.close(subject.projectId, subject.path);
      return "Unity was closed without saving. The gate goes on.";
    },
    decided: (_subject, approval, approved) => {
      filed.delete(approval.id);
      answers.set(approval.id, approved);
    },
  });

  /**
   * Returns when no editor has the workspace's folder open. An agent's editor is waited for. The user's editor
   * needs a yes first (R10.5), asked on Home; quitting Unity by hand ends the wait too.
   */
  const waitForFreeEditor = async (
    workspace: Workspace,
    gate: string,
    log: (text: string) => void,
    signal: AbortSignal,
  ) => {
    const target = resolve(workspace.path);
    let approvalId: string | undefined;
    try {
      for (;;) {
        signal.throwIfAborted();
        const state = await editors.scan(workspace.projectId);
        if (!state.editors.some((editor) => editor.path === target)) return;
        const answer = approvalId === undefined ? undefined : answers.get(approvalId);
        if (answer === false) throw new Error(`The user declined to close Unity on ${target}`);
        if (answer === true && approvalId !== undefined) {
          // An approve that closed nothing (the editor had gone, or an agent had it) answers a question that is
          // over. An editor that is open now is a new one: ask again.
          attended.delete(approvalId);
          answers.delete(approvalId);
          approvalId = undefined;
        }
        if (state.lease?.path === target && state.lease.owner === "agent") {
          log("An agent has Unity open on this folder. Waiting for it to finish.\n");
        } else if (approvalId === undefined) {
          // A question an earlier gate left open for this folder is still the question: ask it once.
          approvalId = [...filed].find(
            ([id, subject]) =>
              subject.path === target &&
              subject.projectId === workspace.projectId &&
              !attended.has(id),
          )?.[0];
          if (approvalId === undefined) {
            const chat = await agents.activeWorker(workspace.id);
            approvalId = approvals.file(
              { agentId: chat.id, workspaceId: workspace.id },
              {
                kind: CLOSE_KIND,
                title: `Close Unity on ${workspace.name} for the ${gate} gate?`,
                reason: `Unity batch mode cannot run tests while an editor has ${target} open. Approve closes the editor without saving: unsaved changes to scenes, prefabs, and settings are lost. Decline fails the gate. You can also save and quit Unity yourself, and the gate goes on.`,
                subject: { projectId: workspace.projectId, path: target },
              },
            ).id;
            filed.set(approvalId, { projectId: workspace.projectId, path: target });
          }
          attended.add(approvalId);
          log(
            `Unity has this folder open. Asked on Home before closing it (approval ${approvalId}).\n`,
          );
        }
        await deps.sleep(POLL_MS, signal);
      }
    } finally {
      if (approvalId !== undefined) attended.delete(approvalId);
    }
  };

  for (const mode of MODES) {
    const provided: ProvidedAction = {
      name: gateName(mode),
      description: `Unity ${mode} tests in batch mode. Waits for the editor of this folder to close.`,
      trait: "unity",
      prepare: async ({ workspace, runId, log, signal }) => {
        await waitForFreeEditor(workspace, provided.name, log, signal);
        // Unity writes the report here; `after` moves it into the workspace's artifacts.
        const output = join(deps.reportDir, `pi-spore-unity-report-${runId}.xml`);
        return {
          argv: [
            deps.unity.command,
            ...deps.unity.args,
            "test",
            resolve(workspace.path),
            "--mode",
            mode,
            "--output",
            output,
            "--timeout",
            String(TEST_TIMEOUT_SECONDS),
            "--no-banner",
            "--non-interactive",
          ],
          // The CLI stops Unity at its own --timeout; this is a margin for a CLI that hangs itself.
          timeoutMs: deps.testDeadlineMs,
          after: async (_exitCode, stopped) => {
            try {
              // A cancelled or timed-out run has no report worth keeping.
              if (stopped) return;
              let xml: string;
              try {
                xml = await readFile(output, "utf8");
              } catch {
                throw new Error(`unity test wrote no report to ${output}`);
              }
              await artifacts.write(
                { scope: "workspace", id: workspace.id },
                reportPath(runId),
                xml,
              );
            } finally {
              await rm(output, { force: true });
            }
          },
        };
      },
    };
    actions.provide(provided);
  }

  return async (workspace) => {
    const runs = actions
      .runs(workspace.id, { actions: MODES.map(gateName), limit: 5 })
      .flatMap((run) => {
        const mode = MODES.find((candidate) => gateName(candidate) === run.action);
        return mode ? [{ run, mode }] : [];
      });
    const stored = new Set(
      (await artifacts.list({ scope: "workspace", id: workspace.id })).map((info) => info.path),
    );
    return runs.map(({ run, mode }) => ({
      runId: run.id,
      mode,
      status: run.status,
      createdAt: run.createdAt,
      ...(stored.has(reportPath(run.id)) ? { report: reportPath(run.id) } : {}),
    }));
  };
}
