import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { registerTool } from "../registry.js";
import type { Config } from "../../config/schema.js";

export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const DEFAULT_BASH_OUTPUT_CAP_BYTES = 65_536; // 64 KB

export interface BashResult {
  exit_code: number | null;
  output: string;
  truncated: boolean;
  timed_out: boolean;
}

/**
 * Resolve `allowed_paths` entries (which may include glob suffixes) to absolute
 * base directories, then check whether `resolvedCwd` is at or beneath one of them.
 */
export function isCwdAllowed(resolvedCwd: string, allowedPaths: string[]): boolean {
  for (const ap of allowedPaths) {
    // Strip trailing glob suffix (e.g. "/**", "/*") to get the base directory.
    const base = resolvePath(ap.replace(/\/?\*+$/, "") || ".");
    if (resolvedCwd === base || resolvedCwd.startsWith(base + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Register the bash tool using values from the active config.
 * Must be called after the config is loaded (e.g. in cli/index.ts).
 * Re-registering overwrites the previous entry, so it is safe to call on hot-reload.
 */
export function registerBashTool(config: Config): void {
  const timeoutMs = config.bash_timeout_ms;
  const outputCapBytes = config.bash_output_cap_bytes;
  const allowedPaths = config.policy.allowed_paths;

  registerTool({
    name: "bash",
    description:
      "Execute a shell command within the configured workspace. " +
      "The working directory (cwd) must resolve to a path within allowed_paths. " +
      "Combined stdout+stderr is capped; output exceeding the cap is truncated. " +
      "Non-zero exit codes and timeouts are surfaced in the result.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: {
          type: "string",
          description:
            "Working directory for the command. Must be within an allowed path. " +
            "Defaults to the current working directory.",
        },
      },
      required: ["command"],
    },
    async execute(args): Promise<BashResult> {
      const command = String(args["command"] ?? "");
      if (!command) throw new Error("bash: 'command' argument is required");

      const rawCwd = String(args["cwd"] ?? ".");
      const resolvedCwd = resolvePath(rawCwd);

      // Defense-in-depth: validate resolved absolute cwd against allowed paths.
      // The policy engine performs a first-pass check on the raw cwd string;
      // this check catches traversal tricks after path resolution.
      if (!isCwdAllowed(resolvedCwd, allowedPaths)) {
        throw new Error(`bash: cwd '${resolvedCwd}' is outside allowed paths`);
      }

      return new Promise<BashResult>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let truncated = false;
        let timedOut = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

        const proc = spawn("/bin/sh", ["-c", command], {
          cwd: resolvedCwd,
          // detached: isolate into its own process group so a process-group
          // kill cleans up all subprocesses and their file descriptors,
          // ensuring the 'close' event fires even when the shell spawns children.
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        /** Send signal to the entire process group. Falls back to killing just
         *  the direct child if the group kill fails (e.g. already exited). */
        const killGroup = (signal: NodeJS.Signals) => {
          if (proc.pid === undefined) return;
          try {
            process.kill(-proc.pid, signal);
          } catch {
            try { proc.kill(signal); } catch { /* already gone */ }
          }
        };

        const timer = setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          forceKillTimer = setTimeout(() => killGroup("SIGKILL"), 500);
        }, timeoutMs);

        const onData = (chunk: Buffer) => {
          if (truncated) return;
          const remaining = outputCapBytes - totalBytes;
          if (chunk.length >= remaining) {
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            totalBytes = outputCapBytes;
            truncated = true;
          } else {
            chunks.push(chunk);
            totalBytes += chunk.length;
          }
        };

        proc.stdout.on("data", onData);
        proc.stderr.on("data", onData);

        proc.on("error", (err) => {
          clearTimeout(timer);
          clearTimeout(forceKillTimer);
          reject(err);
        });

        proc.on("close", (code) => {
          clearTimeout(timer);
          clearTimeout(forceKillTimer);
          let output = Buffer.concat(chunks).toString("utf8");
          if (truncated) {
            output += `\n[Output truncated at ${outputCapBytes} bytes]`;
          }
          resolve({
            exit_code: timedOut ? null : code,
            output,
            truncated,
            timed_out: timedOut,
          });
        });
      });
    },
  });
}
