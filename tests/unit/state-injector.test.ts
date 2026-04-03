import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/core/state-injector.js";
import type { Config } from "../../src/config/schema.js";
import type { SessionInfo } from "../../src/memory/session.js";

const testConfig: Config = {
  model: "test-model",
  max_tokens: 512,
  token_budget: 50_000,
  audit_log_path: ".agent/audit.jsonl",
  db_path: ".agent/memory.db",
  prompt_pack: "default@1.0.0",
  strict_schema_mode: true,
  local_model_fallback: false,
  docs_url: "https://example.com",
  help_cmd: "claude-code --help",
  payload_size_limit_bytes: 8192,
  redact_patterns: [],
  policy: {
    name: "test",
    allowed_tools: ["read_file"],
    allowed_paths: ["."],
    deny_patterns: [],
    require_approval_for_writes: true,
  },
};

const testSession: SessionInfo = {
  id: "session-abc",
  model: "test-model",
  policyName: "test",
  turnCount: 3,
};

describe("buildSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("injects a <state> block", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000);
    expect(prompt).toContain("<state>");
    expect(prompt).toContain("</state>");
  });

  it("state block contains session_id", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000);
    expect(prompt).toContain("session-abc");
  });

  it("state block contains model name", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000);
    expect(prompt).toContain("test-model");
  });

  it("state block contains turn_count", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000);
    expect(prompt).toContain('"turn_count": 3');
  });

  it("state block contains tool_policy", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000);
    expect(prompt).toContain('"tool_policy": "test"');
  });

  it("state block contains strict_schema_mode", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000);
    expect(prompt).toContain('"strict_schema_mode": true');
  });

  it("omits <user_facts> block when no facts provided", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000);
    expect(prompt).not.toContain("<user_facts>");
  });

  it("omits <user_facts> block when empty array is provided", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000, []);
    expect(prompt).not.toContain("<user_facts>");
  });

  it("injects <user_facts> block when facts are provided", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000, [
      { key: "lang", value: "Go" },
      { key: "framework", value: "Fiber" },
    ]);
    expect(prompt).toContain("<user_facts>");
    expect(prompt).toContain("</user_facts>");
    expect(prompt).toContain("lang: Go");
    expect(prompt).toContain("framework: Fiber");
  });

  it("<user_facts> block appears after </state>", () => {
    const prompt = buildSystemPrompt(testConfig, testSession, 50_000, [
      { key: "x", value: "1" },
    ]);
    const stateEnd = prompt.indexOf("</state>");
    const factsStart = prompt.indexOf("<user_facts>");
    expect(stateEnd).toBeGreaterThan(-1);
    expect(factsStart).toBeGreaterThan(stateEnd);
  });
});
