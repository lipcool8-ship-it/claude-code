import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface MemoryRow {
  id?: number;
  key: string;
  value: string;
  fallible: 0 | 1;
  user_confirmed: 0 | 1;
  created_at: string;
  updated_at: string;
}

export class SqliteAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        key           TEXT    NOT NULL UNIQUE,
        value         TEXT    NOT NULL,
        fallible      INTEGER NOT NULL DEFAULT 1,
        user_confirmed INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        started_at  TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at    TEXT,
        turn_count  INTEGER NOT NULL DEFAULT 0,
        model       TEXT    NOT NULL,
        policy_name TEXT    NOT NULL
      );
    `);
  }

  upsertMemory(
    key: string,
    value: string,
    opts: { fallible?: boolean; user_confirmed?: boolean } = {}
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory (key, value, fallible, user_confirmed, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           fallible = excluded.fallible,
           user_confirmed = excluded.user_confirmed,
           updated_at = excluded.updated_at`
      )
      .run(
        key,
        value,
        opts.fallible !== false ? 1 : 0,
        opts.user_confirmed ? 1 : 0
      );
  }

  getMemory(key: string): MemoryRow | undefined {
    return this.db
      .prepare("SELECT * FROM memory WHERE key = ?")
      .get(key) as MemoryRow | undefined;
  }

  /** User-confirmed facts outrank fallible summaries. */
  getEffectiveMemory(key: string): MemoryRow | undefined {
    return (
      (this.db
        .prepare(
          "SELECT * FROM memory WHERE key = ? ORDER BY user_confirmed DESC LIMIT 1"
        )
        .get(key) as MemoryRow | undefined)
    );
  }

  upsertSession(id: string, model: string, policyName: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, model, policy_name)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(id, model, policyName);
  }

  incrementTurn(sessionId: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET turn_count = turn_count + 1 WHERE id = ?"
      )
      .run(sessionId);
  }

  endSession(sessionId: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET ended_at = datetime('now') WHERE id = ?"
      )
      .run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
