import { getTool } from "../tools/registry.js";
import { evaluatePolicy } from "../config/policy-engine.js";
import type { AuditLogger } from "../audit/logger.js";
import type { Policy } from "../config/schema.js";
import type { ToolCall } from "./llm-client.js";

export interface InvokeResult {
  tool_call_id: string;
  tool_name: string;
  result: unknown;
  error?: string;
}

export async function invokeToolCall(
  toolCall: ToolCall,
  policy: Policy,
  audit: AuditLogger,
  sessionId: string,
  signal?: AbortSignal
): Promise<InvokeResult> {
  const toolName = toolCall.function.name;
  let args: Record<string, unknown>;

  try {
    args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  } catch {
    const error = `Failed to parse arguments for tool '${toolName}'`;
    audit.log(sessionId, "tool_error", { tool: toolName, error });
    return { tool_call_id: toolCall.id, tool_name: toolName, result: null, error };
  }

  // Policy gate
  const decision = evaluatePolicy(policy, toolName, args);
  if (!decision.allowed) {
    audit.log(sessionId, "tool_denied", {
      tool: toolName,
      reason: decision.reason,
      args,
    });
    return {
      tool_call_id: toolCall.id,
      tool_name: toolName,
      result: null,
      error: `Policy denied: ${decision.reason}`,
    };
  }

  const tool = getTool(toolName);
  if (!tool) {
    const error = `Unknown tool: '${toolName}'`;
    audit.log(sessionId, "tool_error", { tool: toolName, error });
    return { tool_call_id: toolCall.id, tool_name: toolName, result: null, error };
  }

  try {
    audit.log(sessionId, "tool_start", { tool: toolName, args }, undefined, toolName);
    const result = await tool.execute(args, signal);

    // Emit bash-specific audit events when the result carries lifecycle flags.
    if (toolName === "bash" && result !== null && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (r["timed_out"] === true) {
        audit.log(sessionId, "tool_timeout", { tool: toolName });
      }
      if (r["truncated"] === true) {
        audit.log(sessionId, "tool_output_truncated", { tool: toolName });
      }
    }

    // Emit read_file-specific audit events when the result carries lifecycle flags.
    if (toolName === "read_file" && result !== null && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (r["truncated"] === true) {
        audit.log(sessionId, "tool_truncated", { tool: toolName });
      }
      if (r["is_binary"] === true) {
        audit.log(sessionId, "tool_binary_skipped", { tool: toolName });
      }
    }

    // Re-throw if the turn was cancelled while the tool was running.
    // This must run before tool_complete so the event is never emitted for cancelled turns.
    signal?.throwIfAborted();

    audit.log(
      sessionId,
      "tool_complete",
      { tool: toolName },
      typeof result === "string" ? result : JSON.stringify(result),
      toolName
    );
    return { tool_call_id: toolCall.id, tool_name: toolName, result };
  } catch (err) {
    // Re-throw cancellation so the Orchestrator can handle it at the turn level.
    if (signal?.aborted) throw err;
    const error = err instanceof Error ? err.message : String(err);
    audit.log(sessionId, "tool_error", { tool: toolName, error });
    return { tool_call_id: toolCall.id, tool_name: toolName, result: null, error };
  }
}
