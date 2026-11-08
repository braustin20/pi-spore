import type { JobRunner, Logger, StepOutcome, Store } from "@pi-spore/module-api";
import type { Workspace } from "@pi-spore/shared";

export const DELIVERIES_MIGRATION = `CREATE TABLE agents_deliveries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  message TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
)`;

export const DELIVERIES_JOB_MIGRATION = "ALTER TABLE agents_deliveries ADD COLUMN job_id TEXT";

export const DELIVERY_JOB = "agents.delivery";

interface Row {
  id: string;
  agent_id: string;
  message: string;
}

export interface DeliveriesOptions {
  store: Store;
  jobs: JobRunner;
  log: Logger;
  now: () => number;
  newId: () => string;
  workspaceOf(agentId: string): Workspace;
  /** Whether the agent's chat can run. An older worker chat keeps its rows until it is made active again. */
  canRun(agentId: string): boolean;
  /** Sends the message to the agent, starting it first if needed. Resolves when Pi accepts it. */
  send(agentId: string, message: string): Promise<void>;
}

/**
 * Durable deliveries to agents (architecture 6). A row stays `pending` until Pi accepts the message. Its job on the
 * runner, keyed by the agent so messages keep their order, waits while the workspace is not active or the chat cannot
 * run, and after a failed send. Callers wake the agent's jobs when it is idle again, when its workspace is resumed,
 * and when its chat is made active again. Delivery is at least once: a crash between Pi's accept and the `done`
 * write sends the message again.
 */
export class Deliveries {
  constructor(private readonly options: DeliveriesOptions) {
    options.jobs.define<{ deliveryId: string }, never>(DELIVERY_JOB, [
      { name: "send", run: ({ subject }) => this.send(subject.deliveryId) },
    ]);
    this.startMissingJobs();
  }

  /** Inserts the row and its job together, so the job runs only if the caller's transaction commits. */
  add(agentId: string, message: string): void {
    this.options.store.transaction(() => {
      const id = this.options.newId();
      this.options.store.run(
        "INSERT INTO agents_deliveries (id, agent_id, message, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
        id,
        agentId,
        message,
        this.options.now(),
      );
      this.startJob(id, agentId);
      // An older row that waits after a failed send blocks this one, so a new message tries it again.
      this.options.jobs.wake(DELIVERY_JOB, agentId);
    });
  }

  /** Cancels the jobs of the agent's rows. Call it before the rows are deleted. */
  cancelJobs(agentId: string): void {
    const rows = this.options.store.all<{ job_id: string }>(
      "SELECT job_id FROM agents_deliveries WHERE agent_id = ? AND job_id IS NOT NULL",
      agentId,
    );
    for (const row of rows) this.options.jobs.cancel(row.job_id);
  }

  /** Deletes the agent's pending rows and cancels their jobs. */
  drop(agentId: string): void {
    this.options.store.transaction(() => {
      for (const row of this.pendingRows(agentId)) this.options.jobs.cancel(row.job_id);
      this.options.store.run(
        "DELETE FROM agents_deliveries WHERE agent_id = ? AND state = 'pending'",
        agentId,
      );
    });
  }

  /**
   * Gives the pending rows of one agent to another, oldest first. Each gets a new job keyed by the new agent, started
   * after the jobs the agent already has, so the rows keep their order.
   */
  move(fromAgentId: string, toAgentId: string): void {
    this.options.store.transaction(() => {
      for (const row of this.pendingRows(fromAgentId)) {
        this.options.jobs.cancel(row.job_id);
        this.options.store.run(
          "UPDATE agents_deliveries SET agent_id = ? WHERE id = ?",
          toAgentId,
          row.id,
        );
        this.startJob(row.id, toAgentId);
      }
      this.options.jobs.wake(DELIVERY_JOB, toAgentId);
    });
  }

  private pendingRows(agentId: string): { id: string; job_id: string }[] {
    return this.options.store.all<{ id: string; job_id: string }>(
      "SELECT id, job_id FROM agents_deliveries WHERE agent_id = ? AND state = 'pending' AND job_id IS NOT NULL ORDER BY created_at, id",
      agentId,
    );
  }

  private startJob(deliveryId: string, agentId: string): void {
    const jobId = this.options.jobs.start(DELIVERY_JOB, { deliveryId }, { key: agentId });
    this.options.store.run(
      "UPDATE agents_deliveries SET job_id = ? WHERE id = ?",
      jobId,
      deliveryId,
    );
  }

  /** Pending rows from before deliveries ran on the runner. Oldest first, so the jobs keep the rows' order. */
  private startMissingJobs(): void {
    this.options.store.transaction(() => {
      const rows = this.options.store.all<{ id: string; agent_id: string }>(
        "SELECT id, agent_id FROM agents_deliveries WHERE state = 'pending' AND job_id IS NULL ORDER BY created_at, id",
      );
      for (const row of rows) this.startJob(row.id, row.agent_id);
    });
  }

  private async send(deliveryId: string): Promise<StepOutcome<never>> {
    const { store, log } = this.options;
    const row = store.get<Row>(
      "SELECT id, agent_id, message FROM agents_deliveries WHERE id = ? AND state = 'pending'",
      deliveryId,
    );
    // Retention deleted it.
    if (!row) return { next: null };
    try {
      const workspace = this.options.workspaceOf(row.agent_id);
      if (workspace.state !== "active" || !this.options.canRun(row.agent_id)) return { wait: true };
      await this.options.send(row.agent_id, row.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("A delivery to an agent failed; it stays pending", {
        agent: row.agent_id,
        delivery: row.id,
        error: message,
      });
      // The runner resets its own attempt count when a step waits, so the row keeps the count.
      return {
        wait: true,
        commit: () => {
          store.run(
            "UPDATE agents_deliveries SET attempts = attempts + 1, error = ? WHERE id = ?",
            message,
            row.id,
          );
        },
      };
    }
    return {
      next: null,
      commit: () => {
        store.run(
          "UPDATE agents_deliveries SET state = 'done', attempts = attempts + 1, error = NULL, delivered_at = ? WHERE id = ?",
          this.options.now(),
          row.id,
        );
      },
    };
  }
}
