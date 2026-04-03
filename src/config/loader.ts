import { readFileSync, existsSync } from "node:fs";
import { ConfigSchema, type Config } from "./schema.js";
import { DEFAULTS } from "./defaults.js";

/**
 * Load configuration by merging (lowest → highest priority):
 *   1. built-in defaults
 *   2. config file (.agent/config.json if present)
 *   3. environment variables
 */
export function loadConfig(configPath = ".agent/config.json"): Config {
  let fileConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // ignore malformed file; schema validation will surface it if needed
    }
  }

  const envConfig: Record<string, unknown> = {};
  if (process.env["ANTHROPIC_API_KEY"] ?? process.env["OPENAI_API_KEY"]) {
    envConfig["api_key"] =
      process.env["ANTHROPIC_API_KEY"] ?? process.env["OPENAI_API_KEY"];
  }
  if (process.env["AGENT_MODEL"]) {
    envConfig["model"] = process.env["AGENT_MODEL"];
  }
  if (process.env["AGENT_API_BASE"]) {
    envConfig["api_base_url"] = process.env["AGENT_API_BASE"];
  }
  if (process.env["AGENT_LOCAL_FALLBACK"] === "1") {
    envConfig["local_model_fallback"] = true;
  }
  if (process.env["AGENT_MAX_TOKENS"]) {
    const v = Number(process.env["AGENT_MAX_TOKENS"]);
    if (!Number.isNaN(v)) envConfig["max_tokens"] = v;
  }
  if (process.env["AGENT_TOKEN_BUDGET"]) {
    const v = Number(process.env["AGENT_TOKEN_BUDGET"]);
    if (!Number.isNaN(v)) envConfig["token_budget"] = v;
  }
  if (process.env["AGENT_STRICT_SCHEMA"] !== undefined) {
    envConfig["strict_schema_mode"] = process.env["AGENT_STRICT_SCHEMA"] !== "0";
  }
  if (process.env["AGENT_DB_PATH"]) {
    envConfig["db_path"] = process.env["AGENT_DB_PATH"];
  }
  if (process.env["AGENT_AUDIT_LOG"]) {
    envConfig["audit_log_path"] = process.env["AGENT_AUDIT_LOG"];
  }

  const merged = { ...DEFAULTS, ...fileConfig, ...envConfig };
  return ConfigSchema.parse(merged);
}
