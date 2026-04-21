/**
 * Unit tests for the read_file tool.
 *
 * Tests exercise the tool's execute function directly to verify:
 *   - normal (small) file reads return full content
 *   - files at exactly the size cap are not marked as truncated
 *   - files exceeding the cap are truncated with a notice
 *   - binary files (null byte heuristic) return a structured skip response
 *   - empty files are handled correctly
 *   - missing path argument throws
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerReadFileTool, DEFAULT_READ_FILE_MAX_BYTES } from "../../src/tools/definitions/read-file.js";
import { getTool } from "../../src/tools/registry.js";
import type { Config } from "../../src/config/schema.js";

let tmpDir: string;
let config: Config;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "read-file-tool-test-"));
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
    bash_timeout_ms: 30_000,
    bash_output_cap_bytes: 65_536,
    read_file_max_bytes: DEFAULT_READ_FILE_MAX_BYTES,
    policy: {
      name: "test",
      allowed_tools: ["read_file"],
      allowed_paths: [`${tmpDir}/**`, tmpDir],
      deny_patterns: [],
      require_approval_for_writes: false,
    },
  };
  registerReadFileTool(config);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function getReadFileTool() {
  const tool = getTool("read_file");
  if (!tool) throw new Error("read_file tool not registered");
  return tool;
}

// ─── control case ────────────────────────────────────────────────────────────

describe("read_file — small normal file", () => {
  it("returns full content and no truncated/is_binary flags", async () => {
    const filePath = join(tmpDir, "hello.txt");
    writeFileSync(filePath, "Hello, world!", "utf8");

    const tool = getReadFileTool();
    const result = await tool.execute({ path: filePath }) as {
      path: string;
      content: string;
      truncated?: boolean;
      is_binary?: boolean;
    };

    expect(result.path).toBe(filePath);
    expect(result.content).toBe("Hello, world!");
    expect(result.truncated).toBeUndefined();
    expect(result.is_binary).toBeUndefined();
  });

  it("returns empty string for an empty file", async () => {
    const filePath = join(tmpDir, "empty.txt");
    writeFileSync(filePath, "", "utf8");

    const tool = getReadFileTool();
    const result = await tool.execute({ path: filePath }) as {
      content: string;
      truncated?: boolean;
    };

    expect(result.content).toBe("");
    expect(result.truncated).toBeUndefined();
  });
});

// ─── size guard ───────────────────────────────────────────────────────────────

describe("read_file — exact boundary size", () => {
  it("does not truncate a file that is exactly read_file_max_bytes in size", async () => {
    const cap = 32;
    const tinyCapConfig = { ...config, read_file_max_bytes: cap };
    registerReadFileTool(tinyCapConfig);

    const filePath = join(tmpDir, "exact.txt");
    writeFileSync(filePath, "a".repeat(cap), "utf8"); // exactly cap bytes

    const tool = getReadFileTool();
    const result = await tool.execute({ path: filePath }) as {
      content: string;
      truncated?: boolean;
    };

    expect(result.content).toBe("a".repeat(cap));
    expect(result.truncated).toBeUndefined();
  });
});

describe("read_file — large file truncation", () => {
  it("truncates at the cap, sets truncated flag, and appends a notice", async () => {
    const cap = 16;
    const tinyCapConfig = { ...config, read_file_max_bytes: cap };
    registerReadFileTool(tinyCapConfig);

    const filePath = join(tmpDir, "large.txt");
    writeFileSync(filePath, "a".repeat(cap + 10), "utf8"); // clearly over cap

    const tool = getReadFileTool();
    const result = await tool.execute({ path: filePath }) as {
      content: string;
      truncated: boolean;
      size: number;
    };

    expect(result.truncated).toBe(true);
    expect(result.content).toContain(`[File truncated at ${cap} bytes]`);
    // Content before the notice must be capped at cap bytes
    const textBeforeNotice = result.content.split("\n[File truncated")[0];
    expect(Buffer.byteLength(textBeforeNotice, "utf8")).toBe(cap);
    expect(result.size).toBeGreaterThan(cap);
  });
});

// ─── binary detection ────────────────────────────────────────────────────────

describe("read_file — binary file detection", () => {
  it("returns is_binary=true and size without content for a file containing a null byte", async () => {
    const filePath = join(tmpDir, "data.bin");
    // Mix of printable bytes and a null byte in the middle
    writeFileSync(filePath, Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]));

    const tool = getReadFileTool();
    const result = await tool.execute({ path: filePath }) as {
      path: string;
      is_binary: boolean;
      size: number;
      content?: string;
    };

    expect(result.is_binary).toBe(true);
    expect(result.size).toBe(10);
    expect(result.content).toBeUndefined();
  });

  it("does not flag a plain text file as binary", async () => {
    const filePath = join(tmpDir, "plain.txt");
    writeFileSync(filePath, "no null bytes here\n", "utf8");

    const tool = getReadFileTool();
    const result = await tool.execute({ path: filePath }) as {
      is_binary?: boolean;
      content: string;
    };

    expect(result.is_binary).toBeUndefined();
    expect(result.content).toBe("no null bytes here\n");
  });
});

// ─── argument validation ──────────────────────────────────────────────────────

describe("read_file — argument validation", () => {
  it("throws when path argument is missing", async () => {
    const tool = getReadFileTool();
    await expect(tool.execute({})).rejects.toThrow("'path' argument is required");
  });

  it("throws when the file does not exist", async () => {
    const tool = getReadFileTool();
    await expect(
      tool.execute({ path: join(tmpDir, "nonexistent.txt") })
    ).rejects.toThrow();
  });
});
