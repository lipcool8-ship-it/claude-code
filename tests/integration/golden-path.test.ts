import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration test: golden-path demo flow
 *
 * user request → file read → proposed edit → diff preview → approval → write → audit log entry
 *
 * This file contains two test suites:
 *  1. Component-level: tools + audit logger assembled manually (no LLM, no Orchestrator).
 *  2. Orchestrator-level: full stack driven through Orchestrator with injected RL and mock LLM.
 */

import { registerTool, getTool } from "../../src/tools/registry.js";
import { AuditLogger } from "../../src/audit/logger.js";
import { evaluatePolicy } from "../../src/config/policy-engine.js";
import { computeDiff } from "../../src/core/diff.js";
import type { Policy, Config } from "../../src/config/schema.js";
import { Orchestrator, type RlInterface } from "../../src/core/orchestrator.js";
import { MemoryStore } from "../../src/memory/store.js";
import { createSession } from "../../src/memory/session.js";
import type { LLMClient, LLMResponse } from "../../src/core/llm-client.js";

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

// ─── helpers shared by the Orchestrator-level suite ─────────────────────────

function fakeRl(answers: string[]): RlInterface {
  const queue = [...answers];
  return {
    question: vi.fn(async (_prompt: string) => queue.shift() ?? "/exit"),
    close: vi.fn(),
  };
}

function fakeLlm(responses: LLMResponse[]): LLMClient {
  const queue = [...responses];
  const mock = {
    complete: vi.fn(async () => queue.shift() ?? { content: "done", tool_calls: [] }),
    completeWithRepair: vi.fn(async () => queue.shift() ?? { content: "done", tool_calls: [] }),
  };
  return mock as unknown as LLMClient;
}

function injectLlm(orch: Orchestrator, llm: LLMClient): void {
  (orch as unknown as Record<string, unknown>)["client"] = llm;
  const summarizer = (orch as unknown as Record<string, unknown>)["summarizer"] as Record<string, unknown>;
  summarizer["llm"] = llm;
}

function readAuditEvents(path: string): Array<{ event: string }> {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string });
  } catch {
    return [];
  }
}

// ─── Orchestrator-level golden path ─────────────────────────────────────────

describe("golden path through Orchestrator: read → diff → approve → write → audit", () => {
  let orchTmpDir: string;
  let orchAuditPath: string;
  let orchAudit: AuditLogger;
  let orchStore: MemoryStore;
  let orchConfig: Config;

  beforeEach(() => {
    orchTmpDir = mkdtempSync(join(tmpdir(), "gp-orch-test-"));
    orchAuditPath = join(orchTmpDir, "audit.jsonl");
    orchAudit = new AuditLogger({
      logPath: orchAuditPath,
      payloadSizeLimitBytes: 8192,
      redactPatterns: [],
    });
    orchStore = new MemoryStore({ dbPath: join(orchTmpDir, "memory.db") });
    orchConfig = {
      model: "test-model",
      max_tokens: 512,
      token_budget: 10_000,
      audit_log_path: orchAuditPath,
      db_path: join(orchTmpDir, "memory.db"),
      prompt_pack: "default@1.0.0",
      strict_schema_mode: true,
      local_model_fallback: false,
      docs_url: "https://example.com",
      help_cmd: "claude-code --help",
      payload_size_limit_bytes: 8192,
      redact_patterns: [],
      policy: {
        name: "test",
        allowed_tools: ["read_file", "write_file", "list_dir"],
        allowed_paths: [`${orchTmpDir}/**`, orchTmpDir],
        deny_patterns: [],
        require_approval_for_writes: true,
      },
    };
  });

  afterEach(() => {
    orchStore.close();
    rmSync(orchTmpDir, { recursive: true, force: true });
  });

  it("executes read → write → audit through the full Orchestrator stack", async () => {
    // 1. Seed a file
    const filePath = join(orchTmpDir, "hello.txt");
    writeFileSync(filePath, "hello world\n", "utf8");

    const session = createSession(orchStore, "test-model", "test");
    // RL queue: user request → write approval ("y") → exit
    const rl = fakeRl(["read then update hello.txt", "y", "/exit"]);
    const orch = new Orchestrator(orchConfig, orchAudit, orchStore, session, rl);

    // LLM responses: read_file call → write_file call → plain text confirmation
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          { id: "c1", function: { name: "read_file", arguments: JSON.stringify({ path: filePath }) } },
        ],
      },
      {
        content: null,
        tool_calls: [
          {
            id: "c2",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: filePath, content: "hello claude-code\n" }),
            },
          },
        ],
      },
      { content: "Done — file updated.", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    // 2. Verify file was rewritten on disk
    expect(readFileSync(filePath, "utf8")).toBe("hello claude-code\n");

    // 3. Verify audit trail covers the full spine
    const events = readAuditEvents(orchAuditPath).map((e) => e.event);
    expect(events).toContain("user_input");
    expect(events).toContain("llm_response");
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_complete");
    expect(events).toContain("write_approved");

    // 4. Orchestrator ran exactly 3 LLM calls (read → write → text)
    expect(llm.completeWithRepair).toHaveBeenCalledTimes(3);
  });
});
