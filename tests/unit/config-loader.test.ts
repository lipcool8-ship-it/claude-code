import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/loader.js";

/** Isolate each test from the real process.env */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "loader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig — defaults", () => {
  it("returns valid config when no file and no env vars", () => {
    withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        AGENT_MODEL: undefined,
        AGENT_API_BASE: undefined,
        AGENT_LOCAL_FALLBACK: undefined,
        AGENT_MAX_TOKENS: undefined,
        AGENT_TOKEN_BUDGET: undefined,
        AGENT_STRICT_SCHEMA: undefined,
        AGENT_DB_PATH: undefined,
        AGENT_AUDIT_LOG: undefined,
      },
      () => {
        const cfg = loadConfig(join(tmpDir, "nonexistent.json"));
        expect(cfg.model).toBe("claude-opus-4-5");
        expect(cfg.max_tokens).toBe(4096);
        expect(cfg.token_budget).toBe(100_000);
        expect(cfg.strict_schema_mode).toBe(true);
        expect(cfg.local_model_fallback).toBe(false);
        expect(cfg.policy.name).toBe("default");
      }
    );
  });
});

describe("loadConfig — file config", () => {
  it("merges file config over defaults", () => {
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({ model: "gpt-4o", max_tokens: 2048 }),
      "utf8"
    );
    withEnv(
      { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, AGENT_MODEL: undefined },
      () => {
        const cfg = loadConfig(cfgPath);
        expect(cfg.model).toBe("gpt-4o");
        expect(cfg.max_tokens).toBe(2048);
        // Other defaults remain
        expect(cfg.token_budget).toBe(100_000);
      }
    );
  });

  it("silently ignores a malformed JSON file and falls back to defaults", () => {
    const cfgPath = join(tmpDir, "bad.json");
    writeFileSync(cfgPath, "{ NOT VALID JSON }", "utf8");
    withEnv({ AGENT_MODEL: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      expect(() => loadConfig(cfgPath)).not.toThrow();
      const cfg = loadConfig(cfgPath);
      expect(cfg.model).toBe("claude-opus-4-5");
    });
  });

  it("file config is overridden by env vars", () => {
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ model: "from-file" }), "utf8");
    withEnv({ AGENT_MODEL: "from-env", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(cfgPath);
      expect(cfg.model).toBe("from-env");
    });
  });
});

describe("loadConfig — environment variables", () => {
  it("picks up ANTHROPIC_API_KEY", () => {
    withEnv({ ANTHROPIC_API_KEY: "sk-test-key", OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.api_key).toBe("sk-test-key");
    });
  });

  it("falls back to OPENAI_API_KEY if ANTHROPIC_API_KEY absent", () => {
    withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "oai-key" }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.api_key).toBe("oai-key");
    });
  });

  it("picks up AGENT_MODEL", () => {
    withEnv({ AGENT_MODEL: "o1-mini", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.model).toBe("o1-mini");
    });
  });

  it("picks up AGENT_LOCAL_FALLBACK=1", () => {
    withEnv({ AGENT_LOCAL_FALLBACK: "1", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.local_model_fallback).toBe(true);
    });
  });

  it("AGENT_LOCAL_FALLBACK other than '1' keeps default false", () => {
    withEnv({ AGENT_LOCAL_FALLBACK: "true", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.local_model_fallback).toBe(false);
    });
  });

  it("picks up AGENT_MAX_TOKENS", () => {
    withEnv({ AGENT_MAX_TOKENS: "512", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.max_tokens).toBe(512);
    });
  });

  it("ignores non-numeric AGENT_MAX_TOKENS", () => {
    withEnv({ AGENT_MAX_TOKENS: "bogus", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.max_tokens).toBe(4096); // default
    });
  });

  it("picks up AGENT_TOKEN_BUDGET", () => {
    withEnv({ AGENT_TOKEN_BUDGET: "50000", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.token_budget).toBe(50_000);
    });
  });

  it("AGENT_STRICT_SCHEMA=0 disables strict_schema_mode", () => {
    withEnv({ AGENT_STRICT_SCHEMA: "0", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.strict_schema_mode).toBe(false);
    });
  });

  it("AGENT_STRICT_SCHEMA=1 enables strict_schema_mode", () => {
    withEnv({ AGENT_STRICT_SCHEMA: "1", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.strict_schema_mode).toBe(true);
    });
  });

  it("picks up AGENT_DB_PATH", () => {
    const dbPath = join(tmpDir, "custom.db");
    withEnv({ AGENT_DB_PATH: dbPath, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.db_path).toBe(dbPath);
    });
  });

  it("picks up AGENT_AUDIT_LOG", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    withEnv({ AGENT_AUDIT_LOG: logPath, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      const cfg = loadConfig(join(tmpDir, "none.json"));
      expect(cfg.audit_log_path).toBe(logPath);
    });
  });
});

describe("loadConfig — Zod validation", () => {
  it("throws ZodError when file config contains an invalid value", () => {
    const cfgPath = join(tmpDir, "bad-schema.json");
    writeFileSync(cfgPath, JSON.stringify({ max_tokens: -5 }), "utf8");
    withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      expect(() => loadConfig(cfgPath)).toThrow();
    });
  });

  it("throws ZodError when AGENT_API_BASE is not a valid URL", () => {
    withEnv(
      { AGENT_API_BASE: "not-a-url", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined },
      () => {
        expect(() => loadConfig(join(tmpDir, "none.json"))).toThrow();
      }
    );
  });
});
