import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSlashCommand } from "../../src/cli/slash-commands.js";
import { MemoryStore } from "../../src/memory/store.js";
import { AuditLogger } from "../../src/audit/logger.js";
import type { SessionInfo } from "../../src/memory/session.js";

let tmpDir: string;
let store: MemoryStore;
let audit: AuditLogger;

const session: SessionInfo = {
  id: "test-session",
  model: "test-model",
  policyName: "default",
  turnCount: 5,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "slash-cmd-test-"));
  store = new MemoryStore({ dbPath: join(tmpDir, "memory.db") });
  audit = new AuditLogger({
    logPath: join(tmpDir, "audit.jsonl"),
    payloadSizeLimitBytes: 8192,
    redactPatterns: [],
  });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleSlashCommand", () => {
  it("returns undefined for non-slash input", () => {
    expect(handleSlashCommand("hello agent", session, store, audit)).toBeUndefined();
    expect(handleSlashCommand("exit", session, store, audit)).toBeUndefined();
  });

  it("/help returns help text and does not exit", () => {
    const result = handleSlashCommand("/help", session, store, audit);
    expect(result).toBeDefined();
    expect(result!.exit).toBe(false);
    expect(result!.message).toContain("/remember");
    expect(result!.message).toContain("/exit");
  });

  it("/exit returns exit=true", () => {
    const result = handleSlashCommand("/exit", session, store, audit);
    expect(result!.exit).toBe(true);
  });

  it("/quit and /q also exit", () => {
    expect(handleSlashCommand("/quit", session, store, audit)!.exit).toBe(true);
    expect(handleSlashCommand("/q", session, store, audit)!.exit).toBe(true);
  });

  it("/remember stores a user-confirmed fact", () => {
    const result = handleSlashCommand("/remember lang Go", session, store, audit);
    expect(result!.exit).toBe(false);
    expect(result!.message).toContain("lang");
    expect(result!.message).toContain("Go");
    expect(store.read("lang")).toBe("Go");
  });

  it("/remember handles multi-word values", () => {
    handleSlashCommand("/remember project My Cool Project", session, store, audit);
    expect(store.read("project")).toBe("My Cool Project");
  });

  it("/remember without enough args returns usage hint", () => {
    const result = handleSlashCommand("/remember", session, store, audit);
    expect(result!.exit).toBe(false);
    expect(result!.message).toContain("Usage");
  });

  it("/forget clears a fact", () => {
    store.writeFact("lang", "Go");
    handleSlashCommand("/forget lang", session, store, audit);
    expect(store.read("lang")).toBe("");
  });

  it("/forget without a key returns usage hint", () => {
    const result = handleSlashCommand("/forget", session, store, audit);
    expect(result!.message).toContain("Usage");
  });

  it("/status shows session info", () => {
    const result = handleSlashCommand("/status", session, store, audit);
    expect(result!.exit).toBe(false);
    expect(result!.message).toContain("test-session");
    expect(result!.message).toContain("5");
  });

  it("/status includes CWD", () => {
    const result = handleSlashCommand("/status", session, store, audit);
    expect(result!.message).toContain("CWD");
    expect(result!.message).toContain(process.cwd());
  });

  it("/status includes token_budget when provided via opts", () => {
    const result = handleSlashCommand("/status", session, store, audit, { tokenBudget: 42_000 });
    expect(result!.message).toContain("Budget");
    expect(result!.message).toContain("42");
  });

  it("/status omits Budget line when tokenBudget not provided", () => {
    const result = handleSlashCommand("/status", session, store, audit);
    expect(result!.message).not.toContain("Budget");
  });

  it("/reload returns reload=true and does not exit", () => {
    const result = handleSlashCommand("/reload", session, store, audit);
    expect(result).toBeDefined();
    expect(result!.exit).toBe(false);
    expect(result!.reload).toBe(true);
  });

  it("/help lists /reload", () => {
    const result = handleSlashCommand("/help", session, store, audit);
    expect(result!.message).toContain("/reload");
  });

  it("unknown slash command returns an error message", () => {
    const result = handleSlashCommand("/frobnicate", session, store, audit);
    expect(result!.exit).toBe(false);
    expect(result!.message).toContain("Unknown command");
    expect(result!.message).toContain("/frobnicate");
  });

  it("/remember logs to audit", () => {
    const logSpy = vi.spyOn(audit, "log");
    handleSlashCommand("/remember key value", session, store, audit);
    const events = logSpy.mock.calls.map((c) => c[1]);
    expect(events).toContain("user_fact_stored");
  });
});
