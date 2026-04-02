import { minimatch } from "minimatch";
import type { Policy } from "./schema.js";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Evaluate whether a tool call is permitted under the active policy.
 * All decisions are synchronous and deterministic.
 */
export function evaluatePolicy(
  policy: Policy,
  toolName: string,
  args: Record<string, unknown>
): PolicyDecision {
  // 1. Tool must be in the allowed list
  if (!policy.allowed_tools.includes(toolName)) {
    return { allowed: false, reason: `tool '${toolName}' is not in allowed_tools` };
  }

  // 2. For file-targeting tools, check allowed_paths and deny_patterns
  const path = (args["path"] ?? args["file"] ?? "") as string;
  if (path) {
    const pathAllowed = policy.allowed_paths.some((p) =>
      minimatch(path, p.endsWith("/**") ? p : `${p}/**`, { dot: true }) ||
      minimatch(path, p, { dot: true })
    );
    if (!pathAllowed) {
      return { allowed: false, reason: `path '${path}' is not in allowed_paths` };
    }

    for (const pattern of policy.deny_patterns) {
      if (minimatch(path, pattern, { dot: true })) {
        return { allowed: false, reason: `path '${path}' matches deny_pattern '${pattern}'` };
      }
    }
  }

  return { allowed: true, reason: "ok" };
}
