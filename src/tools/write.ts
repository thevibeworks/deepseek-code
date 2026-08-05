import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { ToolDefinition } from "./index";
import { normalizeAliases } from "./index";

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Write a file, creating parent directories as needed and overwriting " +
    "any existing content. For partial changes to an existing file, use " +
    "edit instead.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to cwd)" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  coerce: (input) =>
    normalizeAliases(input, {
      path: ["file_path", "filename", "file"],
      content: ["text", "contents", "body"],
    }),
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, String(input.content));
    return { output: `Wrote ${Buffer.byteLength(String(input.content), "utf8")} bytes to ${path}.` };
  },
};
