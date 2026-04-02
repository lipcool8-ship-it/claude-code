#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import { buildAuditLogger } from "../audit/logger.js";
import { MemoryStore } from "../memory/store.js";
import { createSession, endSession } from "../memory/session.js";
import { Orchestrator } from "../core/orchestrator.js";

// Register all tools
import "../tools/definitions/read-file.js";
import "../tools/definitions/write-file.js";
import "../tools/definitions/list-dir.js";

const program = new Command();

program
  .name("claude-code")
  .description("Terminal AI agent harness")
  .version("1.0.0");

program
  .command("chat", { isDefault: true })
  .description("Start an interactive chat session with the agent")
  .option("-c, --config <path>", "Path to config file", ".agent/config.json")
  .action(async (opts: { config: string }) => {
    const config = loadConfig(opts.config);

    const audit = buildAuditLogger(
      config.audit_log_path,
      config.payload_size_limit_bytes,
      config.redact_patterns
    );

    const store = new MemoryStore({ dbPath: config.db_path });
    const session = createSession(store, config.model, config.policy.name);

    audit.log(session.id, "session_start", {
      model: config.model,
      policy: config.policy.name,
      prompt_pack: config.prompt_pack,
      strict_schema_mode: config.strict_schema_mode,
      local_model_fallback: config.local_model_fallback,
    });

    const orchestrator = new Orchestrator(config, audit, store, session);

    try {
      await orchestrator.run();
    } finally {
      endSession(session, store);
      audit.log(session.id, "session_end", { turn_count: session.turnCount });
      store.close();
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
