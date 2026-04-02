import { readFileSync } from "node:fs";
import { registerTool } from "../registry.js";

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
  async execute(args) {
    const path = String(args["path"] ?? "");
    if (!path) throw new Error("read_file: 'path' argument is required");
    return { path, content: readFileSync(path, "utf8") };
  },
});
