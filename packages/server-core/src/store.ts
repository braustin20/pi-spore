import { DatabaseSync } from "node:sqlite";
import type { SqlValue, Store } from "@pi-spore/module-api";

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 });
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS core_migrations (
      module TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (module, version)
    )`);
  }

  migrate(moduleId: string, migrations: readonly string[]): void {
    this.transaction(() => {
      const row = this.get<{ version: number | null }>(
        "SELECT MAX(version) AS version FROM core_migrations WHERE module = ?",
        moduleId,
      );
      const applied = row?.version ?? 0;
      if (applied > migrations.length) {
        throw new Error(
          `Module "${moduleId}" has ${migrations.length} migrations but the store has ${applied} applied. ` +
            "The store is from a newer pi-spore.",
        );
      }
      migrations.slice(applied).forEach((sql, index) => {
        this.db.exec(sql);
        this.run(
          "INSERT INTO core_migrations (module, version, applied_at) VALUES (?, ?, ?)",
          moduleId,
          applied + index + 1,
          Date.now(),
        );
      });
    });
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    return { changes: Number(this.db.prepare(sql).run(...params).changes) };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error("Store.transaction takes a synchronous function");
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}
