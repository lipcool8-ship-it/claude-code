import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration test: golden-path demo flow
 *
 * user request → file read → proposed edit → diff preview → approval → write → audit log entry
 *
 * This test exercises the real tool implementations and audit logger together
 * (no LLM call — that is mocked at the unit level).
 */

import { registerTool, getTool } from "../../src/tools/registry.js";
import { AuditLogger } from "../../src/audit/logger.js";
import { evaluatePolicy } from "../../src/config/policy-engine.js";
import { computeDiff } from "../../src/core/diff.js";
import type { Policy } from "../../src/config/schema.js";

// Register tools (idempotent in tests)
import "../../src/tools/definitions/read-file.js";
import "../../src/tools/definitions/write-file.js";
import "../../src/tools/definitions/list-dir.js";

let tmpDir: string;
let auditPath: string;
let audit: AuditLogger;
let policy: Policy;
const SESSION = "golden-path-test";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "golden-test-"));
  policy = {
    name: "test",
    allowed_tools: ["read_file", "write_file", "list_dir"],
    allowed_paths: [`${tmpDir}/**`, tmpDir],
    deny_patterns: [],
    require_approval_for_writes: true,
  };
  auditPath = join(tmpDir, "audit.jsonl");
  audit = new AuditLogger({
    logPath: auditPath,
    payloadSizeLimitBytes: 8192,
    redactPatterns: [],
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("golden path: read → diff → approve → write → audit", () => {
  it("executes the full flow end-to-end", async () => {
    // 1. Create a source file
    const filePath = join(tmpDir, "hello.txt");
    writeFileSync(filePath, "hello world\n", "utf8");

    // 2. Read file via tool
    const readTool = getTool("read_file");
    expect(readTool).toBeDefined();

    const decision = evaluatePolicy(policy, "read_file", { path: filePath });
    expect(decision.allowed).toBe(true);

    audit.log(SESSION, "tool_start", { tool: "read_file", path: filePath });
    const readResult = await readTool!.execute({ path: filePath }) as { content: string };
    audit.log(SESSION, "tool_complete", { tool: "read_file" });

    expect(readResult.content).toBe("hello world\n");

    // 3. LLM "proposes" an edit (simulated)
    const proposedContent = "hello claude-code\n";

    // 4. Diff preview
    const { patch, hasChanges } = computeDiff(readResult.content, proposedContent, filePath);
    expect(hasChanges).toBe(true);
    expect(patch).toContain("-hello world");
    expect(patch).toContain("+hello claude-code");

    // 5. User "approves" (simulated)
    const userApproved = true;
    audit.log(SESSION, "write_approved", { path: filePath, approved: userApproved });

    // 6. Write file via tool
    const writeTool = getTool("write_file");
    expect(writeTool).toBeDefined();

    const writeDecision = evaluatePolicy(policy, "write_file", { path: filePath });
    expect(writeDecision.allowed).toBe(true);

    audit.log(SESSION, "tool_start", { tool: "write_file", path: filePath });
    await writeTool!.execute({ path: filePath, content: proposedContent });
    audit.log(SESSION, "tool_complete", { tool: "write_file" });

    // 7. Verify file on disk
    const finalContent = readFileSync(filePath, "utf8");
    expect(finalContent).toBe(proposedContent);

    // 8. Verify audit log entries
    const logLines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(logLines.length).toBeGreaterThanOrEqual(5);

    const events = logLines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_complete");
    expect(events).toContain("write_approved");
  });
});
