import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IdleSummarizer } from "../../src/daemons/idle-summarizer.js";
import { MemoryStore } from "../../src/memory/store.js";
import type { LLMClient } from "../../src/core/llm-client.js";

let tmpDir: string;
let store: MemoryStore;

const FAKE_SUMMARY_JSON = JSON.stringify({
  summary: "User is building a Go API.",
  key_facts: ["lang: Go"],
  open_tasks: ["add tests"],
  fallible: true,
});

function makeMockLLM(): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: FAKE_SUMMARY_JSON,
      tool_calls: [],
    }),
    completeWithRepair: vi.fn().mockResolvedValue({
      content: FAKE_SUMMARY_JSON,
      tool_calls: [],
    }),
  } as unknown as LLMClient;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "summarizer-test-"));
  store = new MemoryStore({ dbPath: join(tmpDir, "memory.db") });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("IdleSummarizer.runOnce", () => {
  it("returns early without calling LLM when turns are undefined", async () => {
    const llm = makeMockLLM();
    const summarizer = new IdleSummarizer(store, llm);
    await summarizer.runOnce(undefined);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("calls LLM and writes a fallible summary to the store", async () => {
    const llm = makeMockLLM();
    const summarizer = new IdleSummarizer(store, llm);

    await summarizer.runOnce("user: hi\nassistant: hello");

    expect(llm.complete).toHaveBeenCalledOnce();
    const facts = store.getAllFacts();
    // Summaries are NOT user_confirmed, so getAllFacts returns nothing
    expect(facts).toHaveLength(0);

    // But we can read by key — key starts with "summary:"
    const call = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const messages = call[0] as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("hi");
  });

  it("summary is stored with fallible=true (not user_confirmed)", async () => {
    const llm = makeMockLLM();
    const writeSummarySpy = vi.spyOn(store, "writeSummary");

    const summarizer = new IdleSummarizer(store, llm);
    await summarizer.runOnce("user: hello");

    expect(writeSummarySpy).toHaveBeenCalledOnce();
    const [key, value] = writeSummarySpy.mock.calls[0] as [string, string];
    expect(key).toMatch(/^summary:/);
    expect(value).toBe(FAKE_SUMMARY_JSON);
  });

  it("summary key is unique on each call", async () => {
    const llm = makeMockLLM();
    const writeSpy = vi.spyOn(store, "writeSummary");

    const summarizer = new IdleSummarizer(store, llm);
    await summarizer.runOnce("turn 1");
    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));
    await summarizer.runOnce("turn 2");

    const keys = writeSpy.mock.calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("IdleSummarizer start/stop", () => {
  it("stop() clears the interval without throwing", () => {
    const llm = makeMockLLM();
    const summarizer = new IdleSummarizer(store, llm, 100_000);
    summarizer.start();
    expect(() => summarizer.stop()).not.toThrow();
  });

  it("stop() before start() does not throw", () => {
    const llm = makeMockLLM();
    const summarizer = new IdleSummarizer(store, llm);
    expect(() => summarizer.stop()).not.toThrow();
  });
});
