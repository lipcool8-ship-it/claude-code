import OpenAI from "openai";
import type { Config } from "../config/schema.js";
import { toolSchemas } from "../tools/registry.js";

export type Message = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string };
export type ToolCall = { id: string; function: { name: string; arguments: string } };
export type LLMResponse = { content: string | null; tool_calls: ToolCall[]; usage?: { total_tokens: number } };

export class LLMClient {
  private client: OpenAI;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.api_key ?? "placeholder",
      baseURL: config.api_base_url,
    });
  }

  async complete(messages: Message[], signal?: AbortSignal): Promise<LLMResponse> {
    const tools = toolSchemas() as OpenAI.Chat.Completions.ChatCompletionTool[];

    const createParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.config.model,
      max_tokens: this.config.max_tokens,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    };
    if (tools.length > 0) {
      createParams.tools = tools;
      createParams.tool_choice = "auto";
    }
    const response = await this.client.chat.completions.create(createParams, { signal });

    const choice = response.choices[0];
    if (!choice) throw new Error("LLM returned no choices");

    const base: LLMResponse = {
      content: choice.message.content ?? null,
      tool_calls: (choice.message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
    if (response.usage) {
      base.usage = { total_tokens: response.usage.total_tokens };
    }
    return base;
  }

  /**
   * Complete with one repair retry on malformed tool call JSON.
   */
  async completeWithRepair(messages: Message[], signal?: AbortSignal): Promise<LLMResponse> {
    const first = await this.complete(messages, signal);

    // Validate tool call argument JSON
    for (const tc of first.tool_calls) {
      try {
        JSON.parse(tc.function.arguments);
      } catch {
        // Repair retry
        const repairMessages: Message[] = [
          ...messages,
          {
            role: "assistant",
            content: tc.function.arguments,
          },
          {
            role: "user",
            content:
              "Your previous response was not valid JSON. Please retry with a valid JSON object for the tool call arguments.",
          },
        ];
        return this.complete(repairMessages, signal);
      }
    }

    return first;
  }
}
