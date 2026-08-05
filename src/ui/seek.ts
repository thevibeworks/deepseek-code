// /seek — parallel investigation.
//
// This is the structural lever M4 concluded was needed. Sub-agents win on
// deep independent work, but ONLY when the parent delegates BEFORE it
// investigates: regime A (delegate first) was 1.30x faster than solo,
// regime B (same mechanism, parent read the material first) was 2.08x
// SLOWER, because the context gets paid for twice. And flash never picks
// regime A on its own — with the task tool present AND a guideline saying
// "delegate before investigating", it spawned nothing in 3/3 runs.
//
// So delegation is driven from outside the model. /seek plans the split
// and pre-spawns, which puts every use in regime A by construction. The
// parent reads nothing first; each child does its own reading.
//
// The guard rail matters as much as the feature. Fan-out on shallow
// lookups measured 2.49x wall-clock and 6.75x cost — per-child fixed
// overhead simply exceeds per-child work. A plan that is not genuinely
// decomposable must answer inline instead, and anything unparseable
// falls back to inline too: refusing to fan out is always the safe error.

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Message } from "../provider/types";
import { streamMessage } from "../provider/client";
import { sanitizeForSummary } from "../engine/compact";
import { MAX_CHILDREN } from "../engine/subagent";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".dsc", ".dscdata", "dist", "build", "target",
  ".next", ".cache", "vendor", "__pycache__", ".venv", "coverage",
]);

/** Bounded map of the workspace for the planner.
 *
 * Without this the planner is asked to write prompts naming real paths
 * while having seen nothing, and it correctly refuses — one live refusal
 * read "The six services are not enumerated". This is orientation, not
 * investigation: a directory listing is the map, not the territory, so it
 * does not put us in the regime where the parent reads the material first
 * and pays for it twice. */
export function workspaceOutline(cwd: string, maxDepth = 3, maxEntries = 200): string {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."));
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith("."));
    for (const f of files.slice(0, 12)) {
      if (out.length >= maxEntries) return;
      out.push(relative(cwd, join(dir, f.name)) || f.name);
    }
    if (files.length > 12) out.push(`${relative(cwd, dir) || "."}/... (${files.length - 12} more files)`);
    for (const d of dirs) walk(join(dir, d.name), depth + 1);
  };
  walk(cwd, 0);
  if (out.length === 0) return "(empty or unreadable working directory)";
  const truncated = out.length >= maxEntries ? "\n... (listing truncated)" : "";
  return out.join("\n") + truncated;
}

export type SeekPiece = { label: string; prompt: string };

export type SeekPlan =
  | { decomposable: false; reason: string }
  | { decomposable: true; pieces: SeekPiece[] };

/** Two pieces is the floor: a "split" of one is just the question. */
export const MIN_PIECES = 2;

const PLAN_INSTRUCTION = `You are planning whether to investigate a question in parallel.

Split it ONLY if it genuinely contains independent parts that can be
investigated at the same time, by separate agents that cannot talk to
each other. Judge honestly against these rules:

- Independent means no part needs another part's ANSWER to begin.
  Sequential work ("find X, then check whether X causes Y") is NOT
  decomposable.
- Each part must be worth a real investigation of its own — several
  files or a genuine trace. A single file read, one definition lookup,
  or a question answerable from one grep is NOT decomposable. Splitting
  shallow work makes it slower and far more expensive, so when in doubt,
  do not split.
- Each part's prompt must be SELF-CONTAINED. The agent receiving it sees
  none of this conversation: no history, no pronouns, no "the file we
  discussed". Name paths, symbols and directories explicitly, and state
  what to report back.
- At most ${MAX_CHILDREN} parts.

Use the file listing below to name real paths in each prompt. If the
listing shows several parallel components (services, packages, modules)
and the question asks about all of them, that IS a valid split: one part
per component.

Reply with JSON only, no prose and no code fences.
  {"decomposable": false, "reason": "<short reason>"}
or
  {"decomposable": true, "pieces": [{"label": "<2-4 words>", "prompt": "<self-contained task>"}]}

Files in the working directory:
`;

const QUESTION_HEADER = "\n\nThe question to plan for:\n";

/** Models wrap JSON in prose or fences often enough that this is required,
 * not defensive. Returns null when nothing parses. */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced !== null ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Validate a parsed plan into the shape the caller can trust. Anything
 * malformed, empty, or under MIN_PIECES becomes "answer inline". */
export function toPlan(parsed: unknown): SeekPlan {
  if (parsed === null || typeof parsed !== "object") {
    return { decomposable: false, reason: "could not plan a split" };
  }
  const o = parsed as Record<string, unknown>;
  if (o.decomposable !== true) {
    return {
      decomposable: false,
      reason: typeof o.reason === "string" && o.reason.trim() !== "" ? o.reason.trim() : "not decomposable",
    };
  }
  const raw = Array.isArray(o.pieces) ? o.pieces : [];
  const pieces: SeekPiece[] = [];
  for (const p of raw) {
    if (p === null || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    const prompt = typeof rec.prompt === "string" ? rec.prompt.trim() : "";
    if (prompt === "") continue;
    const label = typeof rec.label === "string" && rec.label.trim() !== "" ? rec.label.trim() : prompt.slice(0, 40);
    pieces.push({ label, prompt });
    if (pieces.length === MAX_CHILDREN) break;
  }
  if (pieces.length < MIN_PIECES) {
    return { decomposable: false, reason: "only one real piece of work here" };
  }
  return { decomposable: true, pieces };
}

export type PlanOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Conversation so far, so "how does that work" resolves. */
  view: Message[];
  /** Working directory, outlined for the planner. */
  cwd: string;
  signal?: AbortSignal;
};

/** Reasoning tokens are billed against max_tokens on this provider, and a
 * plan for six components can reason for ~10k of them. Measured: at 2048
 * one call in four came back stop=length with 9750 chars of reasoning and
 * ZERO text — which then looked exactly like a considered refusal to
 * split. Budget for the reasoning, not just the JSON. */
const PLAN_MAX_TOKENS = 8_192;

const RETRY_NUDGE =
  "\n\nYour previous reply did not contain complete JSON. Reply with ONLY the " +
  "JSON object, starting with { and ending with }. Keep each prompt to one sentence.";

/** One tool-less call (two if the first is truncated). Cheap, and the view
 * is mostly cache hits. */
export async function planSeek(question: string, opts: PlanOptions): Promise<SeekPlan> {
  const base = PLAN_INSTRUCTION + workspaceOutline(opts.cwd) + QUESTION_HEADER + question;
  const history = sanitizeForSummary(opts.view);

  const attempt = async (text: string): Promise<{ json: unknown | null; truncated: boolean }> => {
    const res = await streamMessage({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      system: "You plan parallel investigations for a coding agent. You reply with JSON only.",
      tools: [],
      messages: [...history, { role: "user", content: [{ type: "text", text }] } as Message],
      maxTokens: PLAN_MAX_TOKENS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      maxAttempts: 2,
    });
    if (res.stopReason === "error" || res.stopReason === "aborted") {
      return { json: null, truncated: false };
    }
    const out = res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { json: extractJson(out), truncated: res.stopReason === "length" || out.trim() === "" };
  };

  const first = await attempt(base);
  if (first.json !== null) return toPlan(first.json);
  if (opts.signal?.aborted === true) return { decomposable: false, reason: "interrupted" };
  // Only truncation is worth a retry; a well-formed refusal already parsed.
  if (!first.truncated) return { decomposable: false, reason: "could not plan a split" };
  const second = await attempt(base + RETRY_NUDGE);
  if (second.json !== null) return toPlan(second.json);
  // Say what actually happened. Reporting this as "not decomposable" would
  // make a truncated plan indistinguishable from a considered refusal.
  return { decomposable: false, reason: "the plan came back truncated" };
}

/** The synthesis turn's prompt. The reports are the only new context the
 * parent gets — it never read the material itself, which is the whole
 * point of delegating first.
 *
 * The re-investigation ban is load-bearing, not politeness. Measured on a
 * 3-way split: children finished in 24s, but the synthesis turn ran 9 more
 * turns re-reading files the reports already covered and pushed the total
 * to 102s against a 70s solo baseline. Paying for the same reading twice
 * is exactly the regime that lost by 2x in M4; it just moves from before
 * the delegation to after it. */
export function synthesisPrompt(question: string, reports: string[]): string {
  return (
    `I asked ${reports.length} sub-agents to investigate this in parallel, each ` +
    `working independently with no shared context:\n\n${question}\n\n` +
    `Their reports follow. They are your evidence — answer FROM them.\n\n` +
    `Do not re-read files a report already covered. That work is already paid ` +
    `for, and redoing it is slower than not having delegated at all. Use a tool ` +
    `only if a report is explicitly partial, empty, or directly contradicts ` +
    `another, and then only for the specific point in question — at most a ` +
    `couple of targeted checks.\n\n` +
    `Synthesize one answer to the question above. Reconcile disagreement ` +
    `explicitly rather than averaging it, and say plainly where a report left ` +
    `a gap rather than filling it in yourself.\n\n` +
    reports.join("\n\n---\n\n")
  );
}
