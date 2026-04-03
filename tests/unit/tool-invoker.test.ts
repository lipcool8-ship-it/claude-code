import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLogger } from "../../src/audit/logger.js";
import { invokeToolCall } from "../../src/core/tool-invoker.js";
import { registerTool } from "../../src/tools/registry.js";
import type { Policy } from "../../src/config/schema.js";
import type { ToolCall } from "../../src/core/llm-client.js";

// Register built-in tools (idempotent)
import { registerReadFileTool } from "../../src/tools/definitions/read-file.js";
import "../../src/tools/definitions/write-file.js";
import "../../src/tools/definitions/list-dir.js";

let tmpDir: string;
let audit: AuditLogger;
const SESSION = "tool-invoker-test";

const openPolicy: Policy = {
  name: "open",
  allowed_tools: ["read_file", "write_file", "list_dir", "echo_tool"],
  allowed_paths: ["/**", "./**"],
  deny_patterns: [],
  require_approval_for_writes: true,
};

const restrictedPolicy: Policy = {
  name: "restricted",
  allowed_tools: ["read_file"],
  allowed_paths: ["./**"],
  deny_patterns: [],
  require_approval_for_writes: true,
};

function makeCall(id: string, name: string, args: object): ToolCall {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tool-invoker-test-"));
  audit = new AuditLogger({
    logPath: join(tmpDir, "audit.jsonl"),
    payloadSizeLimitBytes: 8192,
    redactPatterns: [],
  });
  // Re-register read_file with a permissive config so the tool is available.
  registerReadFileTool({
    model: "test-model",
    max_tokens: 512,
    token_budget: 10_000,
    audit_log_path: join(tmpDir, "audit.jsonl"),
    db_path: join(tmpDir, "memory.db"),
    prompt_pack: "default@1.0.0",
    strict_schema_mode: true,
    local_model_fallback: false,
    docs_url: "https://example.com",
    help_cmd: "test --help",
    payload_size_limit_bytes: 8192,
    redact_patterns: [],
    read_file_max_bytes: 65_536,
    bash_timeout_ms: 30_000,
    bash_output_cap_bytes: 65_536,
    policy: {
      name: "open",
      allowed_tools: ["read_file", "write_file", "list_dir"],
      allowed_paths: ["/**", "./**"],
      deny_patterns: [],
      require_approval_for_writes: false,
    },
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("invokeToolCall — policy gate", () => {
  it("returns an error when the tool is not in allowed_tools", async () => {
    const result = await invokeToolCall(
      makeCall("1", "write_file", { path: "foo.txt", content: "hi" }),
      restrictedPolicy,
      audit,
      SESSION
    );
    expect(result.error).toMatch(/Policy denied/);
    expect(result.result).toBeNull();
  });

  it("returns an error for an unknown tool even when policy allows it", async () => {
    // 'echo_tool' is in openPolicy.allowed_tools but won't be registered until
    // the later test; use a fresh policy that allows it
    const policyAllowingUnknown: Policy = {
      ...openPolicy,
      allowed_tools: ["read_file", "unknown_registered_nowhere"],
    };
    const result = await invokeToolCall(
      makeCall("2", "unknown_registered_nowhere", {}),
      policyAllowingUnknown,
      audit,
      SESSION
    );
    expect(result.error).toMatch(/Unknown tool/);
    expect(result.result).toBeNull();
  });
});

describe("invokeToolCall — argument parsing", () => {
  it("returns an error for malformed JSON arguments", async () => {
    const call: ToolCall = {
      id: "3",
      function: { name: "read_file", arguments: "NOT JSON {{" },
    };
    const result = await invokeToolCall(call, openPolicy, audit, SESSION);
    expect(result.error).toMatch(/Failed to parse arguments/);
    expect(result.result).toBeNull();
  });
});

describe("invokeToolCall — successful execution", () => {
  it("executes a tool and returns its result", async () => {
    // Register a simple echo tool for this test
    registerTool({
      name: "echo_tool",
      description: "Returns the input message.",
      parameters: {
        type: "object",
        properties: { message: { type: "string", description: "Message to echo." } },
        required: ["message"],
      },
      async execute(args) {
        return { echoed: args["message"] };
      },
    });

    const result = await invokeToolCall(
      makeCall("4", "echo_tool", { message: "hello" }),
      openPolicy,
      audit,
      SESSION
    );
    expect(result.error).toBeUndefined();
    expect((result.result as { echoed: string }).echoed).toBe("hello");
  });

  it("list_dir returns entries for an existing directory", async () => {
    const result = await invokeToolCall(
      makeCall("5", "list_dir", { path: tmpDir }),
      openPolicy,
      audit,
      SESSION
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });
});

describe("invokeToolCall — audit log", () => {
  it("logs tool_start and tool_complete on success", async () => {
    const logSpy = vi.spyOn(audit, "log");

    registerTool({
      name: "echo_tool",
      description: "Echo.",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return "pong"; },
    });

    await invokeToolCall(
      makeCall("6", "echo_tool", {}),
      openPolicy,
      audit,
      SESSION
    );

    const events = logSpy.mock.calls.map((c) => c[1]);
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_complete");
  });

  it("logs tool_denied when policy blocks a call", async () => {
    const logSpy = vi.spyOn(audit, "log");

    await invokeToolCall(
      makeCall("7", "write_file", { path: "x.txt", content: "y" }),
      restrictedPolicy,
      audit,
      SESSION
    );

    const events = logSpy.mock.calls.map((c) => c[1]);
    expect(events).toContain("tool_denied");
  });

  it("logs tool_error when execution throws", async () => {
    const logSpy = vi.spyOn(audit, "log");

    registerTool({
      name: "echo_tool",
      description: "Echo.",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { throw new Error("simulated failure"); },
    });

    await invokeToolCall(
      makeCall("8", "echo_tool", {}),
      openPolicy,
      audit,
      SESSION
    );

    const events = logSpy.mock.calls.map((c) => c[1]);
    expect(events).toContain("tool_error");
  });
});
