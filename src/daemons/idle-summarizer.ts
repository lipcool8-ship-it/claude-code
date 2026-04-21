import { readFileSync, existsSync } from "node:fs";
import type { MemoryStore } from "../memory/store.js";
import type { LLMClient } from "../core/llm-client.js";

const SUMMARIZE_PROMPT_PATH = new URL(
  "../../prompts/summarize.md",
  import.meta.url
).pathname;

/**
 * Background idle summarizer.
 *
 * Invariants (per DESIGN.md §7):
 * - Summaries never replace source data (JSONL is untouched)
 * - User-confirmed facts outrank summaries
 * - Summaries are always marked fallible
 * - Summaries are NOT used for write decisions (fresh read always required)
 */
export class IdleSummarizer {
  private store: MemoryStore;
  private llm: LLMClient;
  private intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(store: MemoryStore, llm: LLMClient, intervalMs = 60_000) {
    this.store = store;
    this.llm = llm;
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(turns?: string): Promise<void> {
    if (!turns) return;

    let prompt = "Summarize the following turns:\n\n{{TURNS}}";
    if (existsSync(SUMMARIZE_PROMPT_PATH)) {
      prompt = readFileSync(SUMMARIZE_PROMPT_PATH, "utf8");
    }

    const filled = prompt.replace("{{TURNS}}", turns);
    const response = await this.llm.complete([
      { role: "user", content: filled },
    ]);

    const content = response.content ?? "";
    const summaryKey = `summary:${Date.now()}`;
    // Always written as fallible; never overwrites user-confirmed facts
    this.store.writeSummary(summaryKey, content);
  }
}
