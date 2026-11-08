import type {
  JobRunner,
  JobState,
  JobStep,
  JobTimer,
  JobView,
  Logger,
  StepOutcome,
  Store,
} from "@pi-spore/module-api";

interface JobRow {
  id: string;
  kind: string;
  key: string | null;
  subject: string;
  state: JobState;
  step: string;
  checkpoint: string | null;
  run_at: number | null;
  started_at: number | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

type AnyStep = JobStep<unknown, unknown>;

/** The real timer. `unref` keeps a pending delay from holding the process open. */
export const realTimer: JobTimer = (run, ms) => {
  const handle = setTimeout(() => void run(), ms);
  handle.unref();
  return () => clearTimeout(handle);
};

export interface JobServiceOptions {
  store: Store;
  log: Logger;
  now: () => number;
  newId: () => string;
  timer: JobTimer;
}

/** What core gives each module (`forModule`) and what the server itself drives: resume, stop, and the job routes. */
export interface JobService extends JobRunner {
  /** The runner a module sees: it can define only kinds that start with `<module id>.`. */
  forModule(moduleId: string): JobRunner;
  get(id: string): JobView | undefined;
  /** Runs an `interrupted` or `waiting` job's step again, now. Other states are not changed. */
  retry(id: string): void;
  /** Picks up the jobs a previous run left. Call it once, after every module defined its kinds. */
  resume(): void;
  /** Cancels timers. Steps still running commit nothing, and the runner touches the store no more. */
  stop(): void;
}

export function createJobService(options: JobServiceOptions): JobService {
  return new Jobs(options);
}

class Jobs implements JobService {
  private readonly definitions = new Map<string, readonly AnyStep[]>();
  private readonly listeners: ((job: JobView) => void)[] = [];
  private readonly inFlight = new Set<string>();
  // A step in flight holds its (kind, key) until it settles, even if the job was cancelled meanwhile, so the next job
  // of that key cannot start beside it.
  private readonly busyKeys = new Set<string>();
  private readonly latchedWakes = new Set<string>();
  private readonly timers = new Map<string, () => void>();
  private stopped = false;

  constructor(private readonly options: JobServiceOptions) {}

  forModule(moduleId: string): JobRunner {
    return {
      define: (kind, steps) => {
        if (!kind.startsWith(`${moduleId}.`)) {
          throw new Error(`Job kind "${kind}" must start with "${moduleId}."`);
        }
        this.define(kind, steps);
      },
      start: (kind, subject, startOptions) => this.start(kind, subject, startOptions),
      wake: (kind, key) => this.wake(kind, key),
      cancel: (id) => this.cancel(id),
      retry: (id) => {
        const kind = this.get(id)?.kind;
        if (kind !== undefined && !kind.startsWith(`${moduleId}.`)) {
          throw new Error(`Job ${id} is of kind "${kind}", not one of "${moduleId}."`);
        }
        this.retry(id);
      },
      list: (filter) => this.list(filter),
      onChange: (listener) => this.onChange(listener),
      prune: (before) => this.prune(before),
    };
  }

  define<S, C>(kind: string, steps: readonly JobStep<S, C>[]): void {
    if (this.definitions.has(kind)) throw new Error(`Job kind "${kind}" is already defined`);
    if (steps.length === 0) throw new Error(`Job kind "${kind}" has no steps`);
    this.definitions.set(kind, steps as readonly AnyStep[]);
  }

  start(
    kind: string,
    subject: unknown,
    startOptions: { key?: string; after?: number } = {},
  ): string {
    const steps = this.definitions.get(kind);
    if (!steps) throw new Error(`Job kind "${kind}" is not defined`);
    const { store, now, newId } = this.options;
    const id = newId();
    const at = now();
    const after = startOptions.after ?? 0;
    store.run(
      `INSERT INTO core_jobs (id, kind, key, subject, state, step, run_at, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, 0, ?, ?)`,
      id,
      kind,
      startOptions.key ?? null,
      JSON.stringify(subject),
      (steps[0] as AnyStep).name,
      after > 0 ? at + after : null,
      at,
      at,
    );
    // The caller's transaction may still roll back. By the next tick it has settled, and the pump finds the row or not.
    this.kick();
    return id;
  }

  wake(kind: string, key: string): void {
    const busyKey = keyOf(kind, key);
    if (this.busyKeys.has(busyKey)) {
      this.latchedWakes.add(busyKey);
      return;
    }
    this.applyWake(kind, key);
  }

  cancel(id: string): void {
    const at = this.options.now();
    const { changes } = this.options.store.run(
      `UPDATE core_jobs SET state = 'cancelled', run_at = NULL, started_at = NULL, updated_at = ?
       WHERE id = ? AND state NOT IN ('done', 'cancelled')`,
      at,
      id,
    );
    if (changes === 0) return;
    this.clearTimer(id);
    this.emitById(id);
    this.kick();
  }

  retry(id: string): void {
    const { changes } = this.options.store.run(
      `UPDATE core_jobs SET state = 'running', run_at = NULL, started_at = NULL, updated_at = ?
       WHERE id = ? AND state IN ('interrupted', 'waiting')`,
      this.options.now(),
      id,
    );
    if (changes === 0) return;
    this.emitById(id);
    this.kick();
  }

  get(id: string): JobView | undefined {
    const row = this.row(id);
    return row && toView(row);
  }

  list(filter: { states?: readonly JobState[]; kind?: string; key?: string } = {}): JobView[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.states) {
      where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      params.push(...filter.states);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.key !== undefined) {
      where.push("key = ?");
      params.push(filter.key);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.options.store
      .all<JobRow>(`SELECT * FROM core_jobs ${clause} ORDER BY created_at, id`, ...params)
      .map(toView);
  }

  onChange(listener: (job: JobView) => void): void {
    this.listeners.push(listener);
  }

  prune(before: number): number {
    return this.options.store.run(
      `DELETE FROM core_jobs WHERE state IN ('done', 'cancelled') AND updated_at < ?`,
      before,
    ).changes;
  }

  resume(): void {
    const { store, now } = this.options;
    const rows = store
      .all<JobRow>(
        "SELECT * FROM core_jobs WHERE state IN ('running', 'waiting') ORDER BY created_at, id",
      )
      .filter((row) => this.definitions.has(row.kind));
    for (const row of rows) {
      const step = this.definitions.get(row.kind)?.find((candidate) => candidate.name === row.step);
      // A cut-off agent turn cannot be told apart from one that finished, so a person decides.
      const cutOff = row.started_at !== null && step?.agentTurn === true;
      store.run(
        "UPDATE core_jobs SET state = ?, started_at = CASE WHEN ? THEN started_at END, updated_at = ? WHERE id = ?",
        cutOff ? "interrupted" : "running",
        cutOff ? 1 : 0,
        now(),
        row.id,
      );
      if (cutOff || row.state === "waiting") this.emitById(row.id);
    }
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    for (const cancelTimer of this.timers.values()) cancelTimer();
    this.timers.clear();
  }

  private row(id: string): JobRow | undefined {
    return this.options.store.get<JobRow>("SELECT * FROM core_jobs WHERE id = ?", id);
  }

  private emit(row: JobRow): void {
    const view = toView(row);
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch (error) {
        this.options.log.error("A job listener failed", { job: row.id, error: String(error) });
      }
    }
  }

  private emitById(id: string): void {
    const row = this.row(id);
    if (row) this.emit(row);
  }

  private kick(): void {
    setImmediate(() => this.pump());
  }

  private clearTimer(id: string): void {
    this.timers.get(id)?.();
    this.timers.delete(id);
  }

  private applyWake(kind: string, key: string): void {
    const { changes } = this.options.store.run(
      `UPDATE core_jobs SET state = 'running', run_at = NULL, updated_at = ?
       WHERE kind = ? AND key = ? AND state = 'waiting'`,
      this.options.now(),
      kind,
      key,
    );
    if (changes === 0) return;
    for (const job of this.list({ kind, key, states: ["running"] })) this.emitById(job.id);
    this.kick();
  }

  /** Starts, or schedules, every running job that is not blocked by an older job of its key. */
  private pump(): void {
    if (this.stopped) return;
    const { store, now, timer } = this.options;
    const rows = store.all<JobRow>(
      "SELECT * FROM core_jobs WHERE state = 'running' ORDER BY created_at, id",
    );
    for (const row of rows) {
      if (!this.definitions.has(row.kind) || this.inFlight.has(row.id) || this.timers.has(row.id))
        continue;
      if (this.isBlocked(row)) continue;
      const delay = row.run_at === null ? 0 : row.run_at - now();
      if (delay <= 0) {
        void this.runStep(row.id);
        continue;
      }
      this.timers.set(
        row.id,
        timer(async () => {
          this.timers.delete(row.id);
          await this.runStep(row.id);
        }, delay),
      );
    }
  }

  private isBlocked(row: JobRow): boolean {
    if (row.key === null) return false;
    if (this.busyKeys.has(keyOf(row.kind, row.key))) return true;
    return (
      this.options.store.get(
        `SELECT 1 FROM core_jobs WHERE kind = ? AND key = ? AND state NOT IN ('done', 'cancelled')
         AND (created_at < ? OR (created_at = ? AND id < ?))`,
        row.kind,
        row.key,
        row.created_at,
        row.created_at,
        row.id,
      ) !== undefined
    );
  }

  private async runStep(id: string): Promise<void> {
    if (this.stopped || this.inFlight.has(id)) return;
    const row = this.row(id);
    const steps = row && this.definitions.get(row.kind);
    if (!row || !steps || row.state !== "running" || this.isBlocked(row)) return;
    this.inFlight.add(id);
    const busyKey = row.key === null ? undefined : keyOf(row.kind, row.key);
    if (busyKey !== undefined) this.busyKeys.add(busyKey);
    const { store, now } = this.options;
    try {
      store.run(
        "UPDATE core_jobs SET started_at = ?, updated_at = ? WHERE id = ?",
        now(),
        now(),
        id,
      );
      const step = steps.find((candidate) => candidate.name === row.step);
      let outcome: StepOutcome<unknown> | undefined;
      let failure: unknown;
      try {
        if (!step) throw new Error(`Job kind "${row.kind}" has no step "${row.step}"`);
        outcome = await step.run({
          id,
          subject: JSON.parse(row.subject),
          checkpoint: row.checkpoint === null ? undefined : JSON.parse(row.checkpoint),
          attempts: row.attempts,
        });
      } catch (error) {
        failure = error;
      }
      if (this.stopped) return;
      if (outcome) {
        try {
          this.settle(row, steps, outcome);
        } catch (error) {
          outcome = undefined;
          failure = error;
        }
      }
      if (!outcome) this.fail(row, failure);
    } catch (error) {
      this.options.log.error("A job run failed", { job: id, error: String(error) });
    } finally {
      this.inFlight.delete(id);
      if (busyKey !== undefined) {
        this.busyKeys.delete(busyKey);
        if (!this.stopped && this.latchedWakes.delete(busyKey))
          this.applyWake(row.kind, row.key as string);
      }
      this.pump();
    }
  }

  /** Commits the step's effects with the next step, the checkpoint, and the due time, in one transaction. */
  private settle(row: JobRow, steps: readonly AnyStep[], outcome: StepOutcome<unknown>): void {
    const { store, now } = this.options;
    const written = store.transaction(() => {
      const current = this.row(row.id);
      if (current?.state !== "running" || current.step !== row.step) return false;
      outcome.commit?.();
      let state: JobState = "waiting";
      let step = row.step;
      let runAt: number | null = null;
      if (!outcome.wait) {
        const next =
          outcome.next === undefined
            ? (steps[steps.findIndex((s) => s.name === row.step) + 1]?.name ?? null)
            : outcome.next;
        if (next === null) {
          state = "done";
        } else {
          if (!steps.some((candidate) => candidate.name === next)) {
            throw new Error(`Job kind "${row.kind}" has no step "${next}"`);
          }
          state = "running";
          step = next;
          runAt = outcome.after !== undefined && outcome.after > 0 ? now() + outcome.after : null;
        }
      }
      store.run(
        `UPDATE core_jobs SET state = ?, step = ?, checkpoint = COALESCE(?, checkpoint), run_at = ?, started_at = NULL,
         attempts = 0, error = NULL, updated_at = ? WHERE id = ?`,
        state,
        step,
        outcome.checkpoint === undefined ? null : JSON.stringify(outcome.checkpoint),
        runAt,
        now(),
        row.id,
      );
      return true;
    });
    if (written) this.emitById(row.id);
  }

  private fail(row: JobRow, failure: unknown): void {
    const message = failure instanceof Error ? failure.message : String(failure);
    const { changes } = this.options.store.run(
      `UPDATE core_jobs SET state = 'waiting', attempts = attempts + 1, error = ?, run_at = NULL, started_at = NULL,
       updated_at = ? WHERE id = ? AND state = 'running' AND step = ?`,
      message,
      this.options.now(),
      row.id,
      row.step,
    );
    if (changes === 0) return;
    this.options.log.warn("A job step failed", {
      job: row.id,
      kind: row.kind,
      step: row.step,
      error: message,
    });
    this.emitById(row.id);
  }
}

function keyOf(kind: string, key: string): string {
  return `${kind}\u0000${key}`;
}

function toView(row: JobRow): JobView {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    subject: JSON.parse(row.subject),
    state: row.state,
    step: row.step,
    attempts: row.attempts,
    error: row.error,
    runAt: row.run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
