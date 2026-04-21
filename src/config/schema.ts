import { z } from "zod";

export const PolicySchema = z.object({
  name: z.string(),
  allowed_tools: z.array(z.string()),
  allowed_paths: z.array(z.string()),
  deny_patterns: z.array(z.string()).default([]),
  require_approval_for_writes: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  model: z.string().default("claude-opus-4-5"),
  api_key: z.string().optional(),
  api_base_url: z.string().url().optional(),
  max_tokens: z.number().int().positive().default(4096),
  token_budget: z.number().int().positive().default(100_000),
  policy: PolicySchema.default({
    name: "default",
    allowed_tools: ["read_file", "list_dir", "write_file"],
    allowed_paths: ["."],
    deny_patterns: [],
    require_approval_for_writes: true,
  }),
  audit_log_path: z.string().default(".agent/audit.jsonl"),
  db_path: z.string().default(".agent/memory.db"),
  prompt_pack: z.string().default("default@1.0.0"),
  strict_schema_mode: z.boolean().default(true),
  local_model_fallback: z.boolean().default(false),
  docs_url: z.string().default("https://github.com/lipcool8-ship-it/claude-code#readme"),
  help_cmd: z.string().default("claude-code --help"),
  payload_size_limit_bytes: z.number().int().positive().default(8192),
  redact_patterns: z
    .array(z.string())
    .default(["sk-[A-Za-z0-9]+", "Bearer [A-Za-z0-9._-]+"]),
  bash_timeout_ms: z.number().int().positive().default(30_000),
  bash_output_cap_bytes: z.number().int().positive().default(65_536),
  read_file_max_bytes: z.number().int().positive().default(65_536),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Policy = z.infer<typeof PolicySchema>;
