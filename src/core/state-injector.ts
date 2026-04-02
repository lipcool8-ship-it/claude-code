import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import type { SessionInfo } from "../memory/session.js";

const SYSTEM_PROMPT_PATH = new URL(
  "../../prompts/system.md",
  import.meta.url
).pathname;

function loadSystemPrompt(): string {
  try {
    return readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  } catch {
    return "You are a helpful terminal AI agent.";
  }
}

export function buildSystemPrompt(
  config: Config,
  session: SessionInfo,
  tokenBudget: number
): string {
  const base = loadSystemPrompt();
  const state = JSON.stringify(
    {
      session_id: session.id,
      model: config.model,
      tool_policy: config.policy.name,
      cwd: process.cwd(),
      token_budget: tokenBudget,
      turn_count: session.turnCount,
      prompt_pack: config.prompt_pack,
      strict_schema_mode: config.strict_schema_mode,
      local_model_fallback: config.local_model_fallback,
      docs_url: config.docs_url,
      help_cmd: config.help_cmd,
    },
    null,
    2
  );
  return `${base}\n\n<state>\n${state}\n</state>`;
}
