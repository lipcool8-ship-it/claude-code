import type { Config } from "./schema.js";

export const DEFAULTS: Partial<Config> = {
  model: "claude-opus-4-5",
  max_tokens: 4096,
  token_budget: 100_000,
  audit_log_path: ".agent/audit.jsonl",
  db_path: ".agent/memory.db",
  prompt_pack: "default@1.0.0",
  strict_schema_mode: true,
  local_model_fallback: false,
  docs_url: "https://github.com/lipcool8-ship-it/claude-code#readme",
  help_cmd: "claude-code --help",
  payload_size_limit_bytes: 8192,
  redact_patterns: ["sk-[A-Za-z0-9]+", "Bearer [A-Za-z0-9._-]+"],
  bash_timeout_ms: 30_000,
  bash_output_cap_bytes: 65_536,
};
