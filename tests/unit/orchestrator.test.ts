/**
 * Orchestrator unit tests.
 *
 * The real readline and LLMClient are replaced with lightweight in-process fakes
 * so the tests run without I/O or network access.
 *
 * Each test feeds a canned queue of user inputs and LLM responses, then
 * asserts on console output and audit log entries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Orchestrator, MAX_TOOL_CHAIN_DEPTH, type RlInterface } from "../../src/core/orchestrator.js";
import { AuditLogger } from "../../src/audit/logger.js";
import { MemoryStore } from "../../src/memory/store.js";
import { createSession } from "../../src/memory/session.js";
import type { Config } from "../../src/config/schema.js";
import type { LLMClient, LLMResponse } from "../../src/core/llm-client.js";

// Register tools so tool-invoker can resolve them
import "../../src/tools/definitions/read-file.js";
import "../../src/tools/definitions/write-file.js";
import "../../src/tools/definitions/list-dir.js";

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;
let auditPath: string;
let audit: AuditLogger;
let store: MemoryStore;
let config: Config;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "orch-test-"));
  auditPath = join(tmpDir, "audit.jsonl");
  audit = new AuditLogger({
    logPath: auditPath,
    payloadSizeLimitBytes: 8192,
    redactPatterns: [],
  });
  store = new MemoryStore({ dbPath: join(tmpDir, "memory.db") });
  config = {
    model: "test-model",
    max_tokens: 512,
    token_budget: 10_000,
    audit_log_path: auditPath,
    db_path: join(tmpDir, "memory.db"),
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
      allowed_paths: [`${tmpDir}/**`, tmpDir],
      deny_patterns: [],
      require_approval_for_writes: true,
    },
  };
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a fake readline that drains a queue of preset answers. */
function fakeRl(answers: string[]): RlInterface {
  const queue = [...answers];
  return {
    question: vi.fn(async (_prompt: string) => queue.shift() ?? "/exit"),
    close: vi.fn(),
  };
}

/** Build a mock LLMClient that returns preset responses in order. */
function fakeLlm(responses: LLMResponse[]): LLMClient {
  const queue = [...responses];
  const mock = {
    complete: vi.fn(async () => queue.shift() ?? { content: "done", tool_calls: [] }),
    completeWithRepair: vi.fn(async () => queue.shift() ?? { content: "done", tool_calls: [] }),
  };
  return mock as unknown as LLMClient;
}

/** Read and parse all audit log entries. */
function readAuditEvents(path: string): Array<{ event: string; metadata: Record<string, unknown> }> {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; metadata: Record<string, unknown> });
  } catch {
    return [];
  }
}

/** Inject a mock LLM into the Orchestrator (accesses private field). */
function injectLlm(orch: Orchestrator, llm: LLMClient): void {
  (orch as unknown as Record<string, unknown>)["client"] = llm;
  // Replace the summarizer's LLM too so background tasks don't throw
  const summarizer = (orch as unknown as Record<string, unknown>)["summarizer"] as Record<string, unknown>;
  summarizer["llm"] = llm;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("Orchestrator — plain text response", () => {
  it("prints the LLM response and adds messages to history", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["Hello there", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([{ content: "Hi! How can I help?", tool_calls: [] }]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    expect(llm.completeWithRepair).toHaveBeenCalledOnce();
    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("user_input");
    expect(events).toContain("llm_response");
  });

  it("getSession() returns updated turn_count after run", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["question 1", "question 2", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([
      { content: "answer 1", tool_calls: [] },
      { content: "answer 2", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    expect(orch.getSession().turnCount).toBe(2);
  });
});

describe("Orchestrator — tool call", () => {
  it("invokes a read_file tool call and appends tool result", async () => {
    const { writeFileSync } = await import("node:fs");
    const filePath = join(tmpDir, "greet.txt");
    writeFileSync(filePath, "hello", "utf8");

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["read the file", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([
      // Turn 1: tool call
      {
        content: null,
        tool_calls: [
          { id: "c1", function: { name: "read_file", arguments: JSON.stringify({ path: filePath }) } },
        ],
      },
      // Turn 2 (recursive): text reply with results
      { content: "The file says hello", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    expect(llm.completeWithRepair).toHaveBeenCalledTimes(2);
    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_complete");
  });
});

describe("Orchestrator — write approval", () => {
  it("rejects write when user answers 'n'", async () => {
    const filePath = join(tmpDir, "file.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "original", "utf8");

    const session = createSession(store, "test-model", "test");
    // First question: the user prompt; second question: write approval ("n")
    const rl = fakeRl(["edit the file", "n", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          {
            id: "c1",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: filePath, content: "modified" }),
            },
          },
        ],
      },
      { content: "Write rejected.", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    const { readFileSync: rf } = await import("node:fs");
    expect(rf(filePath, "utf8")).toBe("original"); // file unchanged

    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("write_rejected");
  });

  it("applies write when user answers 'y'", async () => {
    const filePath = join(tmpDir, "file2.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "before", "utf8");

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["edit the file", "y", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          {
            id: "c2",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: filePath, content: "after" }),
            },
          },
        ],
      },
      { content: "Done.", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    const { readFileSync: rf } = await import("node:fs");
    expect(rf(filePath, "utf8")).toBe("after");
  });
});

describe("Orchestrator — LLM error handling", () => {
  it("catches LLM errors, logs llm_error event, and keeps session alive", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["trigger error", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);

    const llm = {
      complete: vi.fn(),
      completeWithRepair: vi.fn().mockRejectedValue(new Error("network timeout")),
    } as unknown as LLMClient;
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();
    errSpy.mockRestore();

    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("llm_error");
    // Session did not crash — /exit was processed
    const llmErr = readAuditEvents(auditPath).find((e) => e.event === "llm_error");
    expect(llmErr?.metadata["error"]).toContain("network timeout");
  });
});

describe("Orchestrator — tool chain depth limit", () => {
  it("stops after MAX_TOOL_CHAIN_DEPTH recursive tool calls", async () => {
    const filePath = join(tmpDir, "x.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "x", "utf8");

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["start chain"]);
    const orch = new Orchestrator(config, audit, store, session, rl);

    // Always return a tool call — forces the recursive loop
    const toolCallResponse: LLMResponse = {
      content: null,
      tool_calls: [
        { id: "c", function: { name: "read_file", arguments: JSON.stringify({ path: filePath }) } },
      ],
    };
    const llm = {
      complete: vi.fn(),
      completeWithRepair: vi.fn().mockResolvedValue(toolCallResponse),
    } as unknown as LLMClient;
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();
    errSpy.mockRestore();

    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("tool_chain_limit_reached");
    // completeWithRepair called exactly MAX_TOOL_CHAIN_DEPTH times before cut-off
    expect(llm.completeWithRepair).toHaveBeenCalledTimes(MAX_TOOL_CHAIN_DEPTH);
  });
});

describe("Orchestrator — slash commands", () => {
  it("/exit terminates the loop immediately", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    expect(llm.completeWithRepair).not.toHaveBeenCalled();
  });

  it("/remember refreshes the system prompt before the next LLM call", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["/remember lang Go", "what is the lang?", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([{ content: "The lang is Go.", tool_calls: [] }]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    // The system message sent to the LLM should contain the remembered fact
    const callArgs = (llm.completeWithRepair as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const messages = callArgs[0] as Array<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("lang");
    expect(systemMsg?.content).toContain("Go");
  });
});
