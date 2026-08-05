// Tool registry + input coercion. DESIGN.md: coercion, not retries —
// alias normalization, string-wrapped-JSON unwrapping, and ONE structured
// error listing every problem at once (each failed call is wasted tokens
// AND a cache-unfriendly extra turn).

export type ToolContext = {
  cwd: string;
  /** Directory for spilled oversize tool output (created on first use). */
  spillDir?: string;
};

export type ToolResult = { output: string; isError?: boolean };

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** One-line entry for the system prompt's tool index (Round 4 delta #3:
   * tool docs live with the tool). Defaults to the description's first
   * sentence. */
  promptSnippet?: string;
  /** Guideline lines this tool contributes to the system prompt, emitted
   * in tool registration order ahead of the generic guidelines. */
  promptGuidelines?: string[];
  /** Normalize sloppy-but-unambiguous inputs before validation. */
  coerce?: (input: Record<string, unknown>) => Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

/** Rename aliased keys in place (first present alias wins, target untouched
 * if already set). Returns a new object; never mutates the tool_use input. */
export function normalizeAliases(
  input: Record<string, unknown>,
  aliases: Record<string, string[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const [target, names] of Object.entries(aliases)) {
    if (out[target] !== undefined) continue;
    for (const alias of names) {
      if (out[alias] !== undefined) {
        out[target] = out[alias];
        delete out[alias];
        break;
      }
    }
  }
  return out;
}

/** If a value that should be an object/array arrived as a JSON string,
 * unwrap it. Leaves the value alone when parsing fails. */
export function unwrapJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return value;
  try {
    return JSON.parse(s);
  } catch {
    return value;
  }
}

/** Minimal schema check: required keys present, primitive types match.
 * Returns every problem in one list. */
export function validateInput(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const required = (schema.required as string[]) ?? [];
  const props = (schema.properties as Record<string, any>) ?? {};
  for (const key of required) {
    if (input[key] === undefined) problems.push(`missing required parameter "${key}"`);
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = props[key];
    // Unknown extra parameters are ignored, not rejected: an error here
    // costs a whole model turn and the extras are harmless.
    if (!spec || value === undefined) continue;
    const t = spec.type;
    if (t === "string" && typeof value !== "string")
      problems.push(`parameter "${key}" must be a string`);
    else if (t === "number" && typeof value !== "number")
      problems.push(`parameter "${key}" must be a number`);
    else if (t === "boolean" && typeof value !== "boolean")
      problems.push(`parameter "${key}" must be a boolean`);
    else if (t === "array" && !Array.isArray(value))
      problems.push(`parameter "${key}" must be an array`);
  }
  return problems;
}
