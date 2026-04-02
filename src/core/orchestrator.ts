import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync, existsSync } from "node:fs";
import { LLMClient, type Message } from "./llm-client.js";
import { invokeToolCall } from "./tool-invoker.js";
import { buildSystemPrompt } from "./state-injector.js";
import { computeDiff } from "./diff.js";
import type { AuditLogger } from "../audit/logger.js";
import type { Config } from "../config/schema.js";
import type { SessionInfo } from "../memory/session.js";
import { nextTurn } from "../memory/session.js";
import type { MemoryStore } from "../memory/store.js";
import { handleSlashCommand } from "../cli/slash-commands.js";
import { IdleSummarizer } from "../daemons/idle-summarizer.js";

export const MAX_TOOL_CHAIN_DEPTH = 10;

/** Minimal readline interface subset used by the Orchestrator (injectable for tests). */
export interface RlInterface {
  question(prompt: string): Promise<string>;
  close(): void;
}

export class Orchestrator {
  private client: LLMClient;
  private config: Config;
  private audit: AuditLogger;
  private store: MemoryStore;
  private session: SessionInfo;
  private messages: Message[] = [];
  private rl: RlInterface;
  private toolChainDepth = 0;
  private summarizer: IdleSummarizer;

  constructor(
    config: Config,
    audit: AuditLogger,
    store: MemoryStore,
    session: SessionInfo,
    rl?: RlInterface
  ) {
    this.config = config;
    this.audit = audit;
    this.store = store;
    this.session = session;
    this.client = new LLMClient(config);
    this.rl = rl ?? readline.createInterface({ input, output });
    this.summarizer = new IdleSummarizer(store, this.client);
  }

  /** Returns the current session (updated turn_count etc.) after run() completes. */
  getSession(): SessionInfo {
    return this.session;
  }

  private buildPrompt(): string {
    return buildSystemPrompt(
      this.config,
      this.session,
      this.config.token_budget,
      this.store.getAllFacts()
    );
  }

  async run(): Promise<void> {
    this.messages = [{ role: "system", content: this.buildPrompt() }];

    this.summarizer.start();
    console.log('Agent ready. Type your request, or /help for commands.\n');

    try {
      while (true) {
        const userInput = await this.rl.question("You: ");
        const trimmed = userInput.trim();

        // Handle slash commands before sending to LLM
        const slashResult = handleSlashCommand(
          trimmed,
          this.session,
          this.store,
          this.audit
        );
        if (slashResult !== undefined) {
          if (slashResult.message) console.log(`\n${slashResult.message}\n`);
          if (slashResult.exit) break;
          // After a /remember, refresh the system prompt so the new fact is visible
          this.messages[0] = { role: "system", content: this.buildPrompt() };
          continue;
        }

        // Legacy bare "exit" support
        if (trimmed.toLowerCase() === "exit") break;

        this.audit.log(this.session.id, "user_input", { length: userInput.length });
        this.messages.push({ role: "user", content: userInput });

        await this.runTurn();
      }
    } finally {
      this.summarizer.stop();
      this.rl.close();
    }
  }

  private async runTurn(): Promise<void> {
    this.session = nextTurn(this.session, this.store);

    // Refresh the system prompt with current turn_count and latest facts
    this.messages[0] = { role: "system", content: this.buildPrompt() };

    let response;
    try {
      response = await this.client.completeWithRepair(this.messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[Agent] LLM error: ${msg}\n`);
      this.audit.log(this.session.id, "llm_error", { error: msg });
      return;
    }

    this.audit.log(this.session.id, "llm_response", {
      has_content: response.content !== null,
      tool_calls: response.tool_calls.length,
    });

    if (response.tool_calls.length === 0) {
      // Plain text response
      const content = response.content ?? "";
      console.log(`\nAgent: ${content}\n`);
      this.messages.push({ role: "assistant", content });

      // Feed the completed exchange to the idle summarizer
      const recentTurns = this.messages
        .slice(-6)
        .filter((m) => m.role !== "system")
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
      void this.summarizer.runOnce(recentTurns);
      return;
    }

    // Add assistant message with tool calls
    this.messages.push({
      role: "assistant",
      content: response.content ?? "",
    });

    // Process each tool call
    for (const toolCall of response.tool_calls) {
      const isWrite = toolCall.function.name === "write_file";

      if (isWrite && this.config.policy.require_approval_for_writes) {
        const approved = await this.handleWriteApproval(toolCall.function.arguments);
        if (!approved) {
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: JSON.stringify({ error: "User rejected the write." }),
          });
          this.audit.log(this.session.id, "write_rejected", {
            tool: toolCall.function.name,
          });
          continue;
        }
      }

      const result = await invokeToolCall(
        toolCall,
        this.config.policy,
        this.audit,
        this.session.id
      );

      this.messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: result.error
          ? JSON.stringify({ error: result.error })
          : JSON.stringify(result.result),
      });
    }

    // Continue the conversation with tool results
    this.toolChainDepth += 1;
    if (this.toolChainDepth >= MAX_TOOL_CHAIN_DEPTH) {
      this.toolChainDepth = 0;
      console.error(
        `\n[Agent] Tool chain depth limit (${MAX_TOOL_CHAIN_DEPTH}) reached. Stopping this turn.\n`
      );
      this.audit.log(this.session.id, "tool_chain_limit_reached", {
        depth: MAX_TOOL_CHAIN_DEPTH,
      });
      return;
    }
    await this.runTurn();
    this.toolChainDepth = 0;
  }

  private async handleWriteApproval(argsJson: string): Promise<boolean> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      console.error("Could not parse write_file arguments.");
      return false;
    }

    const path = String(args["path"] ?? "");
    const newContent = String(args["content"] ?? "");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const { patch, hasChanges } = computeDiff(existing, newContent, path);

    if (!hasChanges) {
      console.log(`\n[No changes to ${path}]\n`);
      return true;
    }

    console.log(`\n--- Proposed changes to ${path} ---`);
    console.log(patch);
    console.log("-----------------------------------");

    const answer = await this.rl.question("Apply this change? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  }
}
