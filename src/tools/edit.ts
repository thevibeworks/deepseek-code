// Edit tool: multi-edit-native schema with arg healing; exact-then-fuzzy
// matching (pi-mono pattern, MIT): exact indexOf first, then a line-based
// match in normalized space (NFKC, trailing-whitespace strip, smart quotes,
// unicode dashes/spaces). All edits match the ORIGINAL content and are
// applied in reverse offset order; overlaps are an error. Failure strings
// are pedagogical: they tell the model exactly how to fix the call.

import { resolve } from "node:path";
import type { ToolDefinition } from "./index";
import { normalizeAliases, unwrapJsonString } from "./index";

type Edit = { oldText: string; newText: string };
type Span = { start: number; end: number; newText: string };

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace text in a file. Each edit's oldText must match the file " +
    "exactly (whitespace included) and uniquely; include enough " +
    "surrounding context to make it unique. Batch related changes to one " +
    "file in a single call via the edits array.",
  promptGuidelines: [
    "Read a file before editing it; edit requires oldText to match the file content exactly.",
  ],
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to cwd)" },
      edits: {
        type: "array",
        description: "List of {oldText, newText} replacements",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  coerce: healEditArgs,
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { output: `File not found: ${path}`, isError: true };
    }
    const raw = await file.text();
    const edits = input.edits as Edit[];
    if (!Array.isArray(edits) || edits.length === 0) {
      return { output: "No edits provided.", isError: true };
    }

    // Normalize representation for matching; restore on write.
    const bom = raw.startsWith("\uFEFF");
    const crlf = raw.includes("\r\n");
    let content = bom ? raw.slice(1) : raw;
    if (crlf) content = content.replaceAll("\r\n", "\n");

    const spans: Span[] = [];
    const problems: string[] = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      const oldText = crlf ? e.oldText.replaceAll("\r\n", "\n") : e.oldText;
      const newText = crlf ? e.newText.replaceAll("\r\n", "\n") : e.newText;
      if (oldText === "") {
        problems.push(`edit ${i + 1}: oldText must not be empty`);
        continue;
      }
      if (oldText === newText) {
        problems.push(`edit ${i + 1}: oldText and newText are identical (no-op)`);
        continue;
      }
      const m = findSpan(content, oldText);
      if ("error" in m) {
        problems.push(`edit ${i + 1}: ${m.error}`);
        continue;
      }
      spans.push({ start: m.start, end: m.end, newText });
    }
    if (problems.length > 0) {
      return { output: problems.join("\n"), isError: true };
    }

    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].start < spans[i - 1].end) {
        return {
          output:
            "Edits overlap in the file. Merge overlapping edits into one " +
            "replacement covering the whole region.",
          isError: true,
        };
      }
    }

    let out = content;
    for (const s of [...spans].reverse()) {
      out = out.slice(0, s.start) + s.newText + out.slice(s.end);
    }
    if (crlf) out = out.replaceAll("\n", "\r\n");
    if (bom) out = "\uFEFF" + out;
    await Bun.write(path, out);
    return { output: `Applied ${spans.length} edit(s) to ${path}.` };
  },
};

function findSpan(
  content: string,
  oldText: string,
): { start: number; end: number } | { error: string } {
  // 1. Exact match.
  const first = content.indexOf(oldText);
  if (first >= 0) {
    if (content.indexOf(oldText, first + 1) >= 0) {
      let count = 0;
      for (let i = content.indexOf(oldText); i >= 0; i = content.indexOf(oldText, i + 1)) count++;
      return {
        error:
          `oldText matches ${count} locations in the file. Add surrounding ` +
          "lines to make it unique.",
      };
    }
    return { start: first, end: first + oldText.length };
  }

  // 2. Fuzzy: whole-line match in normalized space; the replaced span still
  // comes from the original bytes, so untouched lines are preserved exactly.
  const lines = content.split("\n");
  const offsets: number[] = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = off;
    off += lines[i].length + 1;
  }
  const normContent = lines.map(normLine);
  const normOld = oldText.split("\n").map(normLine);
  const n = normOld.length;
  const matches: number[] = [];
  for (let i = 0; i + n <= normContent.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normContent[i + j] !== normOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  if (matches.length === 1) {
    const i = matches[0];
    const start = offsets[i];
    const end = offsets[i + n - 1] + lines[i + n - 1].length;
    return { start, end };
  }
  if (matches.length > 1) {
    return {
      error:
        `oldText matches ${matches.length} locations (after whitespace ` +
        "normalization). Add surrounding lines to make it unique.",
    };
  }
  return {
    error:
      "oldText not found in the file. Read the file first and copy the " +
      "text exactly, including indentation.",
  };
}

function normLine(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/[ \t]+$/, "");
}

/** Heal legacy/aliased argument shapes into {path, edits:[{oldText,newText}]}. */
function healEditArgs(input: Record<string, unknown>): Record<string, unknown> {
  let out = normalizeAliases(input, { path: ["file_path", "filename", "file"] });
  if (out.edits !== undefined) out = { ...out, edits: unwrapJsonString(out.edits) };
  if (Array.isArray(out.edits)) {
    out.edits = (out.edits as Record<string, unknown>[]).map((e) =>
      normalizeAliases(unwrapJsonString(e) as Record<string, unknown>, {
        oldText: ["old_text", "old_string", "oldStr", "old"],
        newText: ["new_text", "new_string", "newStr", "new"],
      }),
    );
    return out;
  }
  // Single-edit legacy shape: {path, old_string, new_string} and friends.
  const single = normalizeAliases(out, {
    oldText: ["old_text", "old_string", "oldStr", "old"],
    newText: ["new_text", "new_string", "newStr", "new"],
  });
  if (typeof single.oldText === "string" && typeof single.newText === "string") {
    return {
      path: single.path,
      edits: [{ oldText: single.oldText, newText: single.newText }],
    };
  }
  return out;
}
