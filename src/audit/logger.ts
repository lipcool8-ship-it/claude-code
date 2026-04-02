import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface AuditEntry {
  ts: string;
  session_id: string;
  event: string;
  tool?: string;
  metadata: Record<string, unknown>;
  payload_hash?: string;
}

export interface AuditLoggerOptions {
  logPath: string;
  payloadSizeLimitBytes: number;
  redactPatterns: RegExp[];
}

export class AuditLogger {
  private logPath: string;
  private payloadSizeLimit: number;
  private redactPatterns: RegExp[];

  constructor(opts: AuditLoggerOptions) {
    this.logPath = opts.logPath;
    this.payloadSizeLimit = opts.payloadSizeLimitBytes;
    this.redactPatterns = opts.redactPatterns;
    mkdirSync(dirname(opts.logPath), { recursive: true });
  }

  log(
    sessionId: string,
    event: string,
    metadata: Record<string, unknown>,
    payload?: string,
    tool?: string
  ): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      session_id: sessionId,
      event,
      metadata,
    };
    if (tool) entry.tool = tool;
    if (payload !== undefined) {
      const redacted = this.redact(payload);
      if (Buffer.byteLength(redacted, "utf8") > this.payloadSizeLimit) {
        entry.payload_hash = sha256(redacted);
      } else {
        entry.metadata["payload"] = redacted;
      }
    }
    appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf8");
  }

  private redact(text: string): string {
    let out = text;
    for (const re of this.redactPatterns) {
      out = out.replace(re, "[REDACTED]");
    }
    return out;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildAuditLogger(
  logPath: string,
  payloadSizeLimitBytes: number,
  redactPatterns: string[]
): AuditLogger {
  return new AuditLogger({
    logPath,
    payloadSizeLimitBytes,
    redactPatterns: redactPatterns.map((p) => new RegExp(p, "g")),
  });
}
