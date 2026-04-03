import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { registerTool } from "../registry.js";

registerTool({
  name: "write_file",
  description:
    "Write text content to a file. Requires prior user approval of a diff preview.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative or absolute path to the file." },
      content: { type: "string", description: "Full new content of the file." },
    },
    required: ["path", "content"],
  },
  async execute(args) {
    const path = String(args["path"] ?? "");
    const content = String(args["content"] ?? "");
    if (!path) throw new Error("write_file: 'path' argument is required");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return { path, bytes_written: Buffer.byteLength(content, "utf8") };
  },
});
