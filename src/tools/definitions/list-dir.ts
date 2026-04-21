import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { registerTool } from "../registry.js";

registerTool({
  name: "list_dir",
  description: "List the files and directories at the given path (non-recursive).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative or absolute directory path. Defaults to '.'.",
      },
    },
    required: [],
  },
  async execute(args) {
    const dir = String(args["path"] ?? ".");
    const entries = readdirSync(dir).map((name) => {
      const full = join(dir, name);
      const stat = statSync(full);
      return { name, type: stat.isDirectory() ? "dir" : "file", size: stat.size };
    });
    return { path: dir, entries };
  },
});
