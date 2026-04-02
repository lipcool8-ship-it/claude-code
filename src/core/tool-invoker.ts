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
  sessionId: string
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
    const result = await tool.execute(args);
    audit.log(
      sessionId,
      "tool_complete",
      { tool: toolName },
      typeof result === "string" ? result : JSON.stringify(result),
      toolName
    );
    return { tool_call_id: toolCall.id, tool_name: toolName, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    audit.log(sessionId, "tool_error", { tool: toolName, error });
    return { tool_call_id: toolCall.id, tool_name: toolName, result: null, error };
  }
}
