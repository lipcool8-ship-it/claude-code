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
import { registerBashTool } from "../../src/tools/definitions/bash.js";

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

describe("Orchestrator — list_dir tool flow", () => {
  it("executes list_dir without requiring approval and returns entries", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tmpDir, "alpha.txt"), "a", "utf8");
    writeFileSync(join(tmpDir, "beta.txt"), "b", "utf8");

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["list the files", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          { id: "d1", function: { name: "list_dir", arguments: JSON.stringify({ path: tmpDir }) } },
        ],
      },
      { content: "I see the files.", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    // list_dir went through the non-approval path — tool_start and tool_complete logged
    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_complete");
    // No write_approved or write_rejected events
    expect(events).not.toContain("write_approved");
    expect(events).not.toContain("write_rejected");

    // Two LLM calls: first returned list_dir, second returned text
    expect(llm.completeWithRepair).toHaveBeenCalledTimes(2);
  });
});

describe("Orchestrator — token budget tracking", () => {
  it("decrements tokenBudget by usage.total_tokens returned by LLM", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["hello", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([
      { content: "Hi!", tool_calls: [], usage: { total_tokens: 250 } },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    expect(orch.getTokenBudget()).toBe(config.token_budget - 250);
  });

  it("keeps tokenBudget unchanged when LLM response has no usage", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["hello", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([{ content: "Hi!", tool_calls: [] }]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    expect(orch.getTokenBudget()).toBe(config.token_budget);
  });

  it("/status includes token_budget line with live value", async () => {
    const session = createSession(store, "test-model", "test");
    // Use one LLM turn to burn some budget, then check /status
    const rl = fakeRl(["hello", "/status", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([
      { content: "Hi!", tool_calls: [], usage: { total_tokens: 100 } },
    ]);
    injectLlm(orch, llm);

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logLines.push(msg);
    });
    await orch.run();
    consoleSpy.mockRestore();

    const statusOutput = logLines.join("\n");
    expect(statusOutput).toContain("Budget");
    expect(statusOutput).toContain((config.token_budget - 100).toLocaleString());
  });

  it("clamps tokenBudget at zero when usage exceeds the remaining budget", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["hello", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    // Report more tokens than the entire budget
    const llm = fakeLlm([
      { content: "Hi!", tool_calls: [], usage: { total_tokens: config.token_budget + 5_000 } },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();
    warnSpy.mockRestore();

    // Budget must not go negative
    expect(orch.getTokenBudget()).toBe(0);
  });

  it("emits budget_exhausted audit event when budget is first exceeded", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["hello", "/exit"]);
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([
      { content: "Hi!", tool_calls: [], usage: { total_tokens: config.token_budget + 1 } },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();
    warnSpy.mockRestore();

    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("budget_exhausted");
  });
});

describe("Orchestrator — config live reload", () => {
  it("/reload hot-swaps config and resets tokenBudget to new value", async () => {
    const { writeFileSync } = await import("node:fs");
    const configPath = join(tmpDir, "agent-config.json");
    // Write a config file with a distinct token_budget
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "test-model",
        token_budget: 55_000,
        policy: {
          name: "test",
          allowed_tools: ["read_file", "write_file", "list_dir"],
          allowed_paths: [`${tmpDir}/**`, tmpDir],
          deny_patterns: [],
          require_approval_for_writes: true,
        },
      }),
      "utf8"
    );

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["/reload", "/exit"]);
    // Pass configPath as 6th constructor arg
    const orch = new Orchestrator(config, audit, store, session, rl, configPath);
    const llm = fakeLlm([]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    expect(orch.getTokenBudget()).toBe(55_000);
  });

  it("/reload with no configPath prints a skip message and does not crash", async () => {
    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["/reload", "/exit"]);
    // No configPath passed
    const orch = new Orchestrator(config, audit, store, session, rl);
    const llm = fakeLlm([]);
    injectLlm(orch, llm);

    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logLines.push(msg);
    });
    await orch.run();
    consoleSpy.mockRestore();

    expect(logLines.join("\n")).toContain("reload skipped");
    expect(orch.getTokenBudget()).toBe(config.token_budget);
  });
});

// ─── Orchestrator — bash tool integration ───────────────────────────────────
//
// These tests exercise the full Orchestrator → invokeToolCall → bash tool path.
// The bash tool is re-registered in each test so the per-test tmpDir is reflected
// in the allowedPaths closure.

describe("Orchestrator — bash tool: successful command", () => {
  it("executes bash and surfaces exit_code 0 in the tool result message", async () => {
    const bashConfig: Config = {
      ...config,
      bash_timeout_ms: 5_000,
      bash_output_cap_bytes: 65_536,
      policy: {
        ...config.policy,
        allowed_tools: ["read_file", "write_file", "list_dir", "bash"],
      },
    };
    registerBashTool(bashConfig);

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["run echo", "/exit"]);
    const orch = new Orchestrator(bashConfig, audit, store, session, rl);
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          {
            id: "b1",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "echo hello-world", cwd: tmpDir }),
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

    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_complete");
    expect(events).not.toContain("tool_denied");

    const messages = (orch as unknown as Record<string, unknown>)["messages"] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("exit_code");
    expect(toolMsg?.content).toContain("hello-world");
  });
});

describe("Orchestrator — bash tool: timeout", () => {
  it("emits tool_timeout audit event and returns timed_out in the tool result", async () => {
    const bashConfig: Config = {
      ...config,
      bash_timeout_ms: 150,
      bash_output_cap_bytes: 65_536,
      policy: {
        ...config.policy,
        allowed_tools: ["read_file", "write_file", "list_dir", "bash"],
      },
    };
    registerBashTool(bashConfig);

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["run sleep", "/exit"]);
    const orch = new Orchestrator(bashConfig, audit, store, session, rl);
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          {
            id: "b2",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "sleep 10", cwd: tmpDir }),
            },
          },
        ],
      },
      { content: "Timed out.", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("tool_timeout");

    const messages = (orch as unknown as Record<string, unknown>)["messages"] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("timed_out");
  }, 5_000);
});

describe("Orchestrator — bash tool: output truncation", () => {
  it("emits tool_output_truncated audit event and includes truncation notice in result", async () => {
    const bashConfig: Config = {
      ...config,
      bash_timeout_ms: 5_000,
      bash_output_cap_bytes: 20,
      policy: {
        ...config.policy,
        allowed_tools: ["read_file", "write_file", "list_dir", "bash"],
      },
    };
    registerBashTool(bashConfig);

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["run big output", "/exit"]);
    const orch = new Orchestrator(bashConfig, audit, store, session, rl);
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          {
            id: "b3",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: "printf 'abcdefghijklmnopqrstuvwxyz1234'",
                cwd: tmpDir,
              }),
            },
          },
        ],
      },
      { content: "Truncated.", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("tool_output_truncated");

    const messages = (orch as unknown as Record<string, unknown>)["messages"] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("truncated");
  });
});

describe("Orchestrator — bash tool: denied cwd escape", () => {
  it("policy denies the tool call when cwd is outside allowed_paths", async () => {
    const bashConfig: Config = {
      ...config,
      bash_timeout_ms: 5_000,
      bash_output_cap_bytes: 65_536,
      policy: {
        ...config.policy,
        allowed_tools: ["read_file", "write_file", "list_dir", "bash"],
      },
    };
    registerBashTool(bashConfig);

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["escape attempt", "/exit"]);
    const orch = new Orchestrator(bashConfig, audit, store, session, rl);
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          {
            id: "b4",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "cat /etc/passwd", cwd: "/etc" }),
            },
          },
        ],
      },
      { content: "Denied.", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    const events = readAuditEvents(auditPath).map((e) => e.event);
    expect(events).toContain("tool_denied");
    expect(events).not.toContain("tool_start");

    const deniedEvent = readAuditEvents(auditPath).find((e) => e.event === "tool_denied");
    expect(String(deniedEvent?.metadata["reason"] ?? "")).toContain("/etc");
  });
});

describe("Orchestrator — bash tool: non-zero exit code", () => {
  it("surfaces non-zero exit_code in the tool result without crashing the session", async () => {
    const bashConfig: Config = {
      ...config,
      bash_timeout_ms: 5_000,
      bash_output_cap_bytes: 65_536,
      policy: {
        ...config.policy,
        allowed_tools: ["read_file", "write_file", "list_dir", "bash"],
      },
    };
    registerBashTool(bashConfig);

    const session = createSession(store, "test-model", "test");
    const rl = fakeRl(["run failing command", "/exit"]);
    const orch = new Orchestrator(bashConfig, audit, store, session, rl);
    const llm = fakeLlm([
      {
        content: null,
        tool_calls: [
          {
            id: "b5",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "exit 7", cwd: tmpDir }),
            },
          },
        ],
      },
      { content: "Command failed.", tool_calls: [] },
    ]);
    injectLlm(orch, llm);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await orch.run();
    consoleSpy.mockRestore();

    // Session must remain alive — two LLM calls expected
    expect(llm.completeWithRepair).toHaveBeenCalledTimes(2);

    const messages = (orch as unknown as Record<string, unknown>)["messages"] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = messages.find((m) => m.role === "tool");
    const parsed = JSON.parse(toolMsg?.content ?? "{}") as { exit_code?: number };
    expect(parsed.exit_code).toBe(7);
  });
});
