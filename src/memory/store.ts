import { SqliteAdapter } from "./sqlite-adapter.js";

export interface StoreOptions {
  dbPath: string;
}

export class MemoryStore {
  private adapter: SqliteAdapter;

  constructor(opts: StoreOptions) {
    this.adapter = new SqliteAdapter(opts.dbPath);
  }

  /** Write a fallible summary. Summaries never replace source data. */
  writeSummary(key: string, value: string): void {
    this.adapter.upsertMemory(key, value, { fallible: true, user_confirmed: false });
  }

  /** Write a user-confirmed fact. Takes precedence over summaries. */
  writeFact(key: string, value: string): void {
    this.adapter.upsertMemory(key, value, { fallible: false, user_confirmed: true });
  }

  /** Read the most authoritative value for a key (user-confirmed facts win). */
  read(key: string): string | undefined {
    return this.adapter.getEffectiveMemory(key)?.value;
  }

  upsertSession(id: string, model: string, policyName: string): void {
    this.adapter.upsertSession(id, model, policyName);
  }

  incrementTurn(sessionId: string): void {
    this.adapter.incrementTurn(sessionId);
  }

  endSession(sessionId: string): void {
    this.adapter.endSession(sessionId);
  }

  close(): void {
    this.adapter.close();
  }
}
