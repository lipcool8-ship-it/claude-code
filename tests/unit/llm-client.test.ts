import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../../src/config/schema.js";
import { LLMClient } from "../../src/core/llm-client.js";

// Minimal config fixture — API key is a placeholder; we mock the HTTP call
const testConfig: Config = {
  model: "test-model",
  max_tokens: 512,
  token_budget: 10_000,
  audit_log_path: ".agent/audit.jsonl",
  db_path: ".agent/memory.db",
  prompt_pack: "default@1.0.0",
  strict_schema_mode: false,
  local_model_fallback: false,
  docs_url: "https://example.com",
  help_cmd: "claude-code --help",
  payload_size_limit_bytes: 8192,
  redact_patterns: [],
  policy: {
    name: "default",
    allowed_tools: ["read_file"],
    allowed_paths: ["."],
    deny_patterns: [],
    require_approval_for_writes: true,
  },
};

function makeMockClient(responses: object[]): LLMClient {
  const client = new LLMClient(testConfig);
  let call = 0;
  // Patch the internal OpenAI client's completions.create
  (client as unknown as Record<string, unknown>)["client"] = {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const resp = responses[call++ % responses.length];
          return resp;
        }),
      },
    },
  };
  return client;
}

function makeChoiceResponse(content: string, toolCalls: object[] = []) {
  return {
    choices: [
      {
        message: {
          content,
          tool_calls: toolCalls,
        },
      },
    ],
  };
}

describe("LLMClient.complete", () => {
  it("returns text content when there are no tool calls", async () => {
    const client = makeMockClient([makeChoiceResponse("Hello, world!")]);
    const result = await client.complete([{ role: "user", content: "Hi" }]);
    expect(result.content).toBe("Hello, world!");
    expect(result.tool_calls).toHaveLength(0);
  });

  it("returns tool calls when present", async () => {
    const client = makeMockClient([
      makeChoiceResponse("", [
        {
          id: "call_1",
          function: { name: "read_file", arguments: '{"path":"foo.ts"}' },
        },
      ]),
    ]);
    const result = await client.complete([{ role: "user", content: "Read foo.ts" }]);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]?.function.name).toBe("read_file");
  });

  it("throws when the API returns no choices", async () => {
    const client = makeMockClient([{ choices: [] }]);
    await expect(
      client.complete([{ role: "user", content: "Hi" }])
    ).rejects.toThrow("no choices");
  });
});

describe("LLMClient.completeWithRepair", () => {
  it("returns the first response when tool arguments are valid JSON", async () => {
    const client = makeMockClient([
      makeChoiceResponse("", [
        {
          id: "call_1",
          function: { name: "read_file", arguments: '{"path":"foo.ts"}' },
        },
      ]),
    ]);
    const result = await client.completeWithRepair([{ role: "user", content: "Read foo.ts" }]);
    expect(result.tool_calls).toHaveLength(1);
  });

  it("retries once when tool arguments are malformed JSON", async () => {
    const createMock = vi.fn()
      .mockResolvedValueOnce(
        makeChoiceResponse("", [
          { id: "c1", function: { name: "read_file", arguments: "INVALID {{" } },
        ])
      )
      .mockResolvedValueOnce(
        makeChoiceResponse("", [
          { id: "c2", function: { name: "read_file", arguments: '{"path":"bar.ts"}' } },
        ])
      );

    const client = new LLMClient(testConfig);
    (client as unknown as Record<string, unknown>)["client"] = {
      chat: { completions: { create: createMock } },
    };

    const result = await client.completeWithRepair([{ role: "user", content: "Read" }]);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.tool_calls[0]?.function.arguments).toBe('{"path":"bar.ts"}');
  });

  it("returns the (still malformed) second response after one repair attempt", async () => {
    const createMock = vi.fn()
      .mockResolvedValue(
        makeChoiceResponse("", [
          { id: "c1", function: { name: "read_file", arguments: "STILL BAD" } },
        ])
      );

    const client = new LLMClient(testConfig);
    (client as unknown as Record<string, unknown>)["client"] = {
      chat: { completions: { create: createMock } },
    };

    const result = await client.completeWithRepair([{ role: "user", content: "Read" }]);
    // Two total calls: original + one repair
    expect(createMock).toHaveBeenCalledTimes(2);
    // Surface the result (even if still malformed) — caller handles it
    expect(result.tool_calls).toHaveLength(1);
  });
});
