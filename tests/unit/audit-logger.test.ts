import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLogger } from "../../src/audit/logger.js";

let tmpDir: string;
let logPath: string;
let logger: AuditLogger;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
  logPath = join(tmpDir, "audit.jsonl");
  logger = new AuditLogger({
    logPath,
    payloadSizeLimitBytes: 128,
    redactPatterns: [/sk-[A-Za-z0-9]+/g],
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("AuditLogger", () => {
  it("appends a JSONL line for each event", () => {
    logger.log("sess1", "tool_start", { tool: "read_file" });
    logger.log("sess1", "tool_complete", { tool: "read_file" });

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["event"]).toBe("tool_start");
    expect(entry["session_id"]).toBe("sess1");
    expect(entry["ts"]).toBeTruthy();
  });

  it("redacts sensitive patterns in payloads", () => {
    logger.log("sess1", "llm_output", {}, "Here is your key: sk-abc123XYZ");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    const metadata = entry["metadata"] as Record<string, unknown>;
    expect(String(metadata["payload"])).not.toMatch(/sk-abc123XYZ/);
    expect(String(metadata["payload"])).toMatch(/\[REDACTED\]/);
  });

  it("stores a hash instead of payload when payload exceeds size limit", () => {
    const bigPayload = "x".repeat(256);
    logger.log("sess1", "llm_output", {}, bigPayload);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["payload_hash"]).toBeTruthy();
    const metadata = entry["metadata"] as Record<string, unknown>;
    expect(metadata["payload"]).toBeUndefined();
  });

  it("always logs metadata regardless of payload", () => {
    logger.log("sess1", "session_start", { model: "claude-opus-4-5", policy: "default" });
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    const metadata = entry["metadata"] as Record<string, unknown>;
    expect(metadata["model"]).toBe("claude-opus-4-5");
    expect(metadata["policy"]).toBe("default");
  });
});
