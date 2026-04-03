import { openSync, readSync, statSync, closeSync } from "node:fs";
import { registerTool } from "../registry.js";
import type { Config } from "../../config/schema.js";

export const DEFAULT_READ_FILE_MAX_BYTES = 65_536; // 64 KB

export interface ReadFileResult {
  path: string;
  content?: string;
  truncated?: boolean;
  is_binary?: boolean;
  size?: number;
}

/**
 * Register the read_file tool using values from the active config.
 * Must be called after the config is loaded (e.g. in cli/index.ts).
 * Re-registering overwrites the previous entry, so it is safe to call on hot-reload.
 */
export function registerReadFileTool(config: Config): void {
  const maxBytes = config.read_file_max_bytes ?? DEFAULT_READ_FILE_MAX_BYTES;

  registerTool({
    name: "read_file",
    description: "Read the text content of a file at the given path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute path to the file." },
      },
      required: ["path"],
    },
    async execute(args): Promise<ReadFileResult> {
      const filePath = String(args["path"] ?? "");
      if (!filePath) throw new Error("read_file: 'path' argument is required");

      const stat = statSync(filePath);
      const fileSize = stat.size;

      // Read up to maxBytes (or the full file if it fits within the cap).
      const readSize = Math.min(maxBytes, fileSize);
      const buf = Buffer.alloc(readSize);

      const fd = openSync(filePath, "r");
      try {
        if (readSize > 0) {
          readSync(fd, buf, 0, readSize, 0);
        }
      } finally {
        closeSync(fd);
      }

      // Binary detection: presence of a null byte in the read portion is a reliable
      // heuristic that covers all common binary formats (executables, images, etc.).
      if (buf.includes(0)) {
        return { path: filePath, is_binary: true, size: fileSize };
      }

      const content = buf.toString("utf8");

      if (fileSize > maxBytes) {
        return {
          path: filePath,
          content: content + `\n[File truncated at ${maxBytes} bytes]`,
          truncated: true,
          size: fileSize,
        };
      }

      return { path: filePath, content };
    },
  });
}
