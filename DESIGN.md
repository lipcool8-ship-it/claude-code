# DESIGN.md — Step 0: Architecture Decision Pack (Revised)

> Status: **Approved** — proceed to Phase 1
> Guiding principle: **Every action must be inspectable, reversible, and policy-bounded.**
> All architecture decisions map back to this rule.

---

## 1. Golden-Path Demo Flow

The single end-to-end flow that proves the system works (v1 primary success spine):

```
user request
  → tool: read_file(path)
  → LLM proposes edit (structured output)
  → diff preview rendered in terminal
  → user approves (y/n prompt)
  → tool: write_file(path, content)   [only on approval]
  → audit log entry written (JSONL)
```

Every other feature is subordinate to this flow being reliable and inspectable.

---

## 2. LLM Support Tiers

| Tier | Models | Guarantees |
|------|--------|-----------|
| Primary | Anthropic Claude, OpenAI GPT-4-class | Full feature set, structured output, high reliability |
| Secondary | Local / OpenAI-compatible endpoints (Ollama, llama.cpp) | Best-effort compatibility, degraded guarantees (no strict schema mode, longer timeouts, no structured output) |

Offline-only operation is **not** a hard v1 success criterion.
Local model support is a secondary, best-effort goal.

---

## 3. Top-Level Design Principle

> **Every action must be inspectable, reversible, and policy-bounded.**

- **Inspectable**: every tool call is previewed before execution; every LLM decision is traceable in the audit log.
- **Reversible**: file writes are staged (diff shown, backup kept); destructive operations require explicit user approval.
- **Policy-bounded**: a policy engine gates all tool calls; policies are user-configurable; no tool runs outside its declared scope.

---

## 4. Audit Logging Policy

| Data class | Treatment |
|------------|-----------|
| Metadata (tool name, timestamp, user ID, outcome) | **Always logged**, verbatim |
| Payloads (file contents, LLM responses) | Logged subject to **redaction rules** + **configurable size limit** (default 8 KB) |
| Sensitive outputs (API keys, tokens, PII patterns) | **Hashed (SHA-256) or summarized**; raw value never written to log |

Log format: **JSONL, append-only** (see §6 Persistence Split).
Each entry contains: `{ ts, session_id, event, tool?, metadata, payload_hash? }`.

---

## 5. Runtime State Contract

The agent maintains and exposes the following state at every turn:

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `string` | Unique per invocation |
| `model` | `string` | Active LLM identifier |
| `tool_policy` | `string` | Policy name in effect |
| `cwd` | `string` | Current working directory |
| `token_budget` | `number` | Remaining context tokens (approx.) |
| `turn_count` | `number` | Turns elapsed this session |
| `prompt_pack` | `string` | Prompt pack name + semver |
| `strict_schema_mode` | `boolean` | Whether structured output is enforced |
| `local_model_fallback` | `boolean` | Whether local-model fallback is active |
| `docs_url` | `string` | URL / path to user-facing docs |
| `help_cmd` | `string` | CLI command to print help |

State is injected into the system prompt at each turn.

---

## 6. Persistence Split

Two separate stores, different access patterns:

| Store | Format | Purpose | Properties |
|-------|--------|---------|-----------|
| Audit / session log | **JSONL file** (append-only) | Full trace of every event | Replayable, human-readable, never mutated in place |
| Structured memory / state | **SQLite database** | Project facts, conversation summaries, preferences | Queryable, indexed, atomic upserts |

These two stores are never conflated.
JSONL is the source of truth for "what happened"; SQLite is the fast read path for "what the agent knows now."

---

## 7. Background Summarization Constraints

The idle summarizer compresses old turns and writes summaries to SQLite.
The following invariants are enforced:

1. **Summaries never replace source data.** JSONL entries are never deleted or overwritten.
2. **User-confirmed facts outrank summaries.** Facts explicitly set by the user (`/remember`) take precedence over any inferred summary.
3. **Summaries are always marked fallible.** Every summary row carries `fallible: true` in metadata.
4. **Summaries are not used for write decisions.** Before any file write, the orchestrator performs a fresh `read_file` and validates against current disk state.

---

## 8. Deferred Extensibility

| Milestone | Feature | Notes |
|-----------|---------|-------|
| **v1.5** | Repo-local "skills" layer | Folder-based skill definitions (`.agent/skills/`). No remote loading. |
| **v2** | Optional vector retrieval | Embed project facts / summaries into a local vector index for semantic search. |

These are explicitly out of scope for v1 but the architecture leaves clean extension points.

---

## 9. LLM Interaction Contract

Every LLM call follows this protocol:

1. **Structured output mode** — use native structured/function-call output when the model/API supports it.
2. **Fallback** — if structured output is unavailable, send a JSON-schema prompt and parse the free-text response.
3. **Repair retry** — on a single malformed tool call, send one repair prompt (`"Your previous response was not valid JSON. Retry:"`) and parse again. If the retry also fails, surface an error to the user; do not silently drop the turn.

---

## 10. Component Map

```
cli/               Entry points (chat REPL, slash commands)
core/
  orchestrator.ts  Turn loop: inject state → call LLM → parse → invoke tools → loop
  llm-client.ts    Structured output + repair retry
  tool-invoker.ts  Gate through policy engine, execute, audit
  diff.ts          Unified diff generation + approval prompt
  state-injector.ts Build system-prompt context block from runtime state
config/
  schema.ts        Zod schema for all config fields
  loader.ts        Load + merge env / file / defaults
  policy-engine.ts Evaluate tool-call permission against active policy
tools/
  registry.ts      Tool registry (name → definition)
  definitions/     read-file, write-file, list-dir, …
memory/
  sqlite-adapter.ts  better-sqlite3 wrapper
  store.ts           Typed read/write API for memory tables
  session.ts         Session lifecycle helpers
audit/
  logger.ts        Append-only JSONL writer with redaction + size limit
prompts/
  system.md        Base system prompt (injected each turn)
  summarize.md     Prompt for background summarization
```

---

## 11. v1 Success Criteria

1. Golden-path demo flow executes end-to-end without errors.
2. Every file write is preceded by a diff preview and user approval.
3. Every tool call produces an audit log entry.
4. Policy engine blocks disallowed tool calls before execution.
5. Malformed LLM output triggers one repair retry; persistent errors surface cleanly to the user.
6. All config and state passes Zod validation on startup.
7. Unit test coverage for policy engine, audit logger, and tool invoker.
