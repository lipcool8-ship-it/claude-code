/**
 * Unit tests for the bash tool.
 *
 * Tests exercise the tool's execute function directly to verify:
 *   - successful command execution
 *   - non-zero exit code surfacing
 *   - wall-clock timeout enforcement
 *   - output cap and truncation notice
 *   - cwd escape rejection (defense-in-depth layer)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerBashTool, isCwdAllowed } from "../../src/tools/definitions/bash.js";
import { getTool } from "../../src/tools/registry.js";
import type { Config } from "../../src/config/schema.js";

let tmpDir: string;
let config: Config;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bash-tool-test-"));
  config = {
    model: "test-model",
    max_tokens: 512,
    token_budget: 10_000,
    audit_log_path: join(tmpDir, "audit.jsonl"),
    db_path: join(tmpDir, "memory.db"),
    prompt_pack: "default@1.0.0",
    strict_schema_mode: true,
    local_model_fallback: false,
    docs_url: "https://example.com",
    help_cmd: "claude-code --help",
    payload_size_limit_bytes: 8192,
    redact_patterns: [],
    bash_timeout_ms: 5_000,
    bash_output_cap_bytes: 65_536,
    policy: {
      name: "test",
      allowed_tools: ["bash"],
      allowed_paths: [`${tmpDir}/**`, tmpDir],
      deny_patterns: [],
      require_approval_for_writes: false,
    },
  };
  registerBashTool(config);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function getBashTool() {
  const tool = getTool("bash");
  if (!tool) throw new Error("bash tool not registered");
  return tool;
}

// ─── isCwdAllowed unit tests ──────────────────────────────────────────────────

describe("isCwdAllowed", () => {
  it("allows an exact match on the base directory", () => {
    expect(isCwdAllowed("/home/user/project", ["/home/user/project"])).toBe(true);
  });

  it("allows a subdirectory of an allowed path", () => {
    expect(isCwdAllowed("/home/user/project/src", ["/home/user/project"])).toBe(true);
  });

  it("allows a path matching a glob-style entry", () => {
    expect(isCwdAllowed("/home/user/project/src", ["/home/user/project/**"])).toBe(true);
  });

  it("rejects a path that is only a prefix of an allowed path", () => {
    expect(isCwdAllowed("/home/user", ["/home/user/project"])).toBe(false);
  });

  it("rejects an entirely different path", () => {
    expect(isCwdAllowed("/etc", ["/home/user/project"])).toBe(false);
  });

  it("rejects a path that shares a prefix but not a directory boundary", () => {
    expect(isCwdAllowed("/home/user/project-evil", ["/home/user/project"])).toBe(false);
  });
});

// ─── execute: success ─────────────────────────────────────────────────────────

describe("bash tool — successful command", () => {
  it("returns exit_code 0 and captures stdout", async () => {
    const tool = getBashTool();
    const result = await tool.execute({ command: "echo hello", cwd: tmpDir }) as {
      exit_code: number;
      output: string;
      truncated: boolean;
      timed_out: boolean;
    };
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("hello");
    expect(result.truncated).toBe(false);
    expect(result.timed_out).toBe(false);
  });

  it("captures stderr in output", async () => {
    const tool = getBashTool();
    const result = await tool.execute({
      command: "echo err >&2",
      cwd: tmpDir,
    }) as { output: string; exit_code: number };
    expect(result.output).toContain("err");
    expect(result.exit_code).toBe(0);
  });

  it("defaults cwd to the current process directory when omitted", async () => {
    // Register with allowed_paths containing cwd so the tool can run without cwd arg
    const cwdConfig = {
      ...config,
      policy: { ...config.policy, allowed_paths: [process.cwd(), `${process.cwd()}/**`] },
    };
    registerBashTool(cwdConfig);
    const tool = getTool("bash")!;
    const result = await tool.execute({ command: "echo ok" }) as { exit_code: number };
    expect(result.exit_code).toBe(0);
    // Restore original registration
    registerBashTool(config);
  });
});

// ─── execute: non-zero exit code ─────────────────────────────────────────────

describe("bash tool — non-zero exit code", () => {
  it("surfaces exit code 1 without throwing", async () => {
    const tool = getBashTool();
    const result = await tool.execute({ command: "exit 1", cwd: tmpDir }) as {
      exit_code: number;
      timed_out: boolean;
    };
    expect(result.exit_code).toBe(1);
    expect(result.timed_out).toBe(false);
  });

  it("surfaces arbitrary non-zero exit codes", async () => {
    const tool = getBashTool();
    const result = await tool.execute({ command: "exit 42", cwd: tmpDir }) as {
      exit_code: number;
    };
    expect(result.exit_code).toBe(42);
  });
});

// ─── execute: timeout ────────────────────────────────────────────────────────

describe("bash tool — timeout", () => {
  it("kills the process and sets timed_out when wall-clock limit is reached", async () => {
    // Register with a very short timeout
    const shortTimeout = { ...config, bash_timeout_ms: 150 };
    registerBashTool(shortTimeout);
    const tool = getTool("bash")!;
    const result = await tool.execute({ command: "sleep 10", cwd: tmpDir }) as {
      timed_out: boolean;
      exit_code: number | null;
    };
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
    // Restore
    registerBashTool(config);
  }, 3_000);
});

// ─── execute: output truncation ──────────────────────────────────────────────

describe("bash tool — output truncation", () => {
  it("truncates output at the configured cap and appends a notice", async () => {
    // Register with a tiny output cap
    const tinyCapConfig = { ...config, bash_output_cap_bytes: 16 };
    registerBashTool(tinyCapConfig);
    const tool = getTool("bash")!;
    const result = await tool.execute({
      // Generate output well above 16 bytes (30 byte string, no newline)
      command: "printf 'abcdefghijklmnopqrstuvwxyz1234'",
      cwd: tmpDir,
    }) as { truncated: boolean; output: string };
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("[Output truncated at 16 bytes]");
    // Restore
    registerBashTool(config);
  });
});

// ─── execute: cwd escape ─────────────────────────────────────────────────────

describe("bash tool — cwd escape rejection", () => {
  it("throws when cwd resolves outside allowed_paths", async () => {
    const tool = getBashTool();
    await expect(
      tool.execute({ command: "echo hi", cwd: "/etc" })
    ).rejects.toThrow("outside allowed paths");
  });

  it("throws when cwd uses traversal to escape the workspace", async () => {
    const tool = getBashTool();
    // Construct a path that starts inside tmpDir but traverses out
    await expect(
      tool.execute({ command: "echo hi", cwd: `${tmpDir}/../../etc` })
    ).rejects.toThrow("outside allowed paths");
  });
});

// ─── execute: AbortSignal cancellation ────────────────────────────────────────

describe("bash tool — AbortSignal cancellation", () => {
  it("resolves with cancelled=true when the abort signal fires during execution", async () => {
    const tool = getBashTool();
    const controller = new AbortController();

    // Schedule abort 100 ms after execution starts so the sleep command is running.
    setTimeout(() => controller.abort(), 100);

    const result = await tool.execute(
      { command: "sleep 10", cwd: tmpDir },
      controller.signal
    ) as { exit_code: number | null; cancelled: boolean; timed_out: boolean };

    expect(result.cancelled).toBe(true);
    expect(result.timed_out).toBe(false);
    expect(result.exit_code).toBeNull();
  }, 3_000);

  it("resolves immediately with cancelled=true when signal is already aborted on entry", async () => {
    const tool = getBashTool();
    const controller = new AbortController();
    controller.abort(); // Pre-abort

    const result = await tool.execute(
      { command: "echo should-not-run", cwd: tmpDir },
      controller.signal
    ) as { cancelled: boolean; exit_code: number | null };

    expect(result.cancelled).toBe(true);
    expect(result.exit_code).toBeNull();
  });
});
