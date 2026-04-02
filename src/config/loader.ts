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

  const merged = { ...DEFAULTS, ...fileConfig, ...envConfig };
  return ConfigSchema.parse(merged);
}
