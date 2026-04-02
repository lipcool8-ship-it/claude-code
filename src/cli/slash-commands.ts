import type { MemoryStore } from "../memory/store.js";
import type { AuditLogger } from "../audit/logger.js";
import type { SessionInfo } from "../memory/session.js";

export interface SlashCommandResult {
  /** If true, the caller should exit the session. */
  exit: boolean;
  /** Optional message to display to the user. */
  message?: string;
}

const HELP_TEXT = `
Slash commands:
  /help                    Show this help text
  /remember <key> <value>  Store a user-confirmed fact (e.g. /remember lang Go)
  /forget <key>            Remove a stored fact (overwrite with empty string)
  /status                  Show session info
  /exit                    End the session
`.trim();

/**
 * Handle a slash command typed by the user.
 * Returns a SlashCommandResult; if the input is not a slash command, returns undefined.
 */
export function handleSlashCommand(
  input: string,
  session: SessionInfo,
  store: MemoryStore,
  audit: AuditLogger
): SlashCommandResult | undefined {
  if (!input.startsWith("/")) return undefined;

  const [cmd, ...rest] = input.slice(1).split(/\s+/);

  switch (cmd?.toLowerCase()) {
    case "help":
      return { exit: false, message: HELP_TEXT };

    case "exit":
    case "quit":
    case "q":
      return { exit: true, message: "Goodbye." };

    case "remember": {
      if (rest.length < 2) {
        return {
          exit: false,
          message: "Usage: /remember <key> <value>",
        };
      }
      const key = rest[0] as string;
      const value = rest.slice(1).join(" ");
      store.writeFact(key, value);
      audit.log(session.id, "user_fact_stored", { key });
      return { exit: false, message: `Remembered: ${key} = ${value}` };
    }

    case "forget": {
      if (rest.length < 1) {
        return { exit: false, message: "Usage: /forget <key>" };
      }
      const key = rest[0] as string;
      store.writeFact(key, "");
      audit.log(session.id, "user_fact_cleared", { key });
      return { exit: false, message: `Cleared: ${key}` };
    }

    case "status": {
      const lines = [
        `Session : ${session.id}`,
        `Model   : ${session.model}`,
        `Policy  : ${session.policyName}`,
        `Turns   : ${session.turnCount}`,
      ];
      return { exit: false, message: lines.join("\n") };
    }

    default:
      return {
        exit: false,
        message: `Unknown command: /${cmd ?? ""}. Type /help for available commands.`,
      };
  }
}
