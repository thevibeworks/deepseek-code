import { resolve } from "node:path";
import type { ToolDefinition } from "./index";
import { normalizeAliases } from "./index";
import { truncateHead } from "./truncate";

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a file. Returns at most 2000 lines (50 KB) per call; use offset " +
    "(1-indexed) and limit to page through larger files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to cwd)" },
      offset: { type: "number", description: "1-indexed first line to read" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["path"],
  },
  coerce: (input) =>
    normalizeAliases(input, { path: ["file_path", "filename", "file"] }),
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { output: `File not found: ${path}`, isError: true };
    }
    const text = await file.text();
    const lines = text.split("\n");
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Number(input.limit ?? 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit).join("\n");
    const r = truncateHead(slice);
    const end = Math.min(offset - 1 + limit, lines.length);
    const notice =
      end < lines.length
        ? `\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`
        : r.truncated
          ? `\n${r.notice}`
          : "";
    return { output: r.text + notice };
  },
};
