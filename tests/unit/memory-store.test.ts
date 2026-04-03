import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../src/memory/store.js";
import { createSession, nextTurn, endSession } from "../../src/memory/session.js";

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-test-"));
  store = new MemoryStore({ dbPath: join(tmpDir, "memory.db") });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("writes and reads a summary", () => {
    store.writeSummary("summary:1", "The user is working on a Go project.");
    const value = store.read("summary:1");
    expect(value).toBe("The user is working on a Go project.");
  });

  it("writes and reads a user-confirmed fact", () => {
    store.writeFact("project_lang", "Go");
    const value = store.read("project_lang");
    expect(value).toBe("Go");
  });

  it("user-confirmed fact outranks a summary for the same key", () => {
    store.writeSummary("lang", "maybe TypeScript");
    store.writeFact("lang", "Go");
    const value = store.read("lang");
    expect(value).toBe("Go");
  });

  it("getAllFacts returns only user-confirmed non-empty entries", () => {
    store.writeFact("lang", "Go");
    store.writeFact("framework", "Fiber");
    store.writeSummary("summary:1", "fallible text");
    const facts = store.getAllFacts();
    const keys = facts.map((f) => f.key);
    expect(keys).toContain("lang");
    expect(keys).toContain("framework");
    expect(keys).not.toContain("summary:1");
  });

  it("getAllFacts excludes cleared (empty-value) facts", () => {
    store.writeFact("lang", "Go");
    store.writeFact("lang", "");      // cleared via /forget
    const facts = store.getAllFacts();
    expect(facts.find((f) => f.key === "lang")).toBeUndefined();
  });
});

describe("session helpers", () => {
  it("creates a session and increments turn count", () => {
    let session = createSession(store, "claude-opus-4-5", "default");
    expect(session.turnCount).toBe(0);
    session = nextTurn(session, store);
    expect(session.turnCount).toBe(1);
    session = nextTurn(session, store);
    expect(session.turnCount).toBe(2);
  });

  it("endSession does not throw", () => {
    const session = createSession(store, "claude-opus-4-5", "default");
    expect(() => endSession(session, store)).not.toThrow();
  });
});
