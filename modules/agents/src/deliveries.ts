import type { Logger, Store } from "@pi-spore/module-api";
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

interface Row {
  id: string;
  agent_id: string;
  message: string;
}

export interface DeliveriesOptions {
  store: Store;
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
 * Durable deliveries to agents (architecture 6). A row stays `pending` until Pi accepts the message. Pending rows
 * are tried again on startup, when the agent is idle again, when its workspace is resumed, and when its chat is made
 * active again. A workspace that is not active, and a chat that cannot run, keep their rows. Delivery is at least once: a crash between Pi's accept and the `done` write sends the
 * message again.
 */
export class Deliveries {
  /** Per agent: the running flush, and whether another one was asked for meanwhile. */
  private readonly flushing = new Map<string, { again: boolean }>();

  constructor(private readonly options: DeliveriesOptions) {}

  add(agentId: string, message: string): void {
    this.options.store.run(
      "INSERT INTO agents_deliveries (id, agent_id, message, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
      this.options.newId(),
      agentId,
      message,
      this.options.now(),
    );
    // After the caller's transaction has committed.
    setImmediate(() => this.flush(agentId));
  }

  /** Agents with pending rows. */
  pendingAgents(): string[] {
    return this.options.store
      .all<{ agent_id: string }>(
        "SELECT DISTINCT agent_id FROM agents_deliveries WHERE state = 'pending'",
      )
      .map((row) => row.agent_id);
  }

  /** Sends the agent's pending rows in order. One flush per agent at a time; a request during one runs after it. */
  flush(agentId: string): void {
    const running = this.flushing.get(agentId);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.flushing.set(agentId, state);
    void this.run(agentId).finally(() => {
      this.flushing.delete(agentId);
      if (state.again) this.flush(agentId);
    });
  }

  private async run(agentId: string): Promise<void> {
    for (;;) {
      const row = this.options.store.get<Row>(
        "SELECT id, agent_id, message FROM agents_deliveries WHERE agent_id = ? AND state = 'pending' ORDER BY created_at, id LIMIT 1",
        agentId,
      );
      if (!row) return;
      let workspace: Workspace;
      try {
        workspace = this.options.workspaceOf(agentId);
      } catch (error) {
        this.fail(row, error);
        return;
      }
      if (workspace.state !== "active" || !this.options.canRun(agentId)) return;
      try {
        await this.options.send(agentId, row.message);
      } catch (error) {
        this.fail(row, error);
        return;
      }
      this.options.store.run(
        "UPDATE agents_deliveries SET state = 'done', attempts = attempts + 1, error = NULL, delivered_at = ? WHERE id = ?",
        this.options.now(),
        row.id,
      );
    }
  }

  private fail(row: Row, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.store.run(
      "UPDATE agents_deliveries SET attempts = attempts + 1, error = ? WHERE id = ?",
      message,
      row.id,
    );
    this.options.log.warn("A delivery to an agent failed; it stays pending", {
      agent: row.agent_id,
      delivery: row.id,
      error: message,
    });
  }
}
