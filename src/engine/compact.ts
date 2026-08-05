// Compaction (DESIGN.md context engine #7, behavioral spec
// reimplemented independently): the single sanctioned prefix break.
// Pipeline: reclaim happens implicitly (old tool results never enter the
// summary), deterministic emergency summary is ALWAYS available with zero
// model calls, an LLM summary (same model, no tools, capped) upgrades it
// when the call succeeds — updating the previous summary instead of
// restarting. Compaction shrinks the context VIEW, never storage.

import type { Message, ToolUseBlock } from "../provider/types";
import { streamMessage } from "../provider/client";
import { estimateTokens } from "./context";

/** Headroom kept below the usable input budget before forcing compaction
 * (common shape: threshold = effective window - fixed reserve). */
export const COMPACT_RESERVE_TOKENS = 13_000;

/** Post-compaction envelope: summary + retained tail aim to fit here. */
export const POST_COMPACT_ENVELOPE_TOKENS = 40_000;

const SUMMARY_MAX_TOKENS = 4_096;

export function compactThreshold(contextBudget: number): number {
  return Math.max(contextBudget - COMPACT_RESERVE_TOKENS, 1_000);
}

export const COMPACTION_PREFIX =
  "[Context was compacted. Summary of the conversation so far:]\n\n";

/** The original task is pinned VERBATIM after the summary — summaries
 * erode across compaction rounds (summary-of-summary telephone), and an
 * agent that loses its task goes hunting the filesystem for it (observed
 * live on parallel-explore: `find . -iname '*task*'`). Pinned last so the
 * task sits closest to the next turn. */
export const TASK_PIN_PREFIX =
  "[The original task, restated verbatim — this is still the goal:]\n\n";

/** One text for the compaction message: summary first, pinned task last.
 * Single user message (not two) so the summary and its task pin cannot be
 * separated by a later tail edit. Consecutive same-role messages are in
 * fact accepted by the /anthropic endpoint (verified live; an interrupted
 * turn produces them), so this is a cohesion choice, not a wire limit. */
export function buildCompactionText(summary: string, task?: string): string {
  return (
    COMPACTION_PREFIX + summary + (task !== undefined && task !== "" ? "\n\n" + TASK_PIN_PREFIX + task : "")
  );
}

/** Deterministic emergency summary: structured digest from the transcript
 * itself. Zero model calls, always available, stable ordering. */
export function emergencySummary(messages: Message[], previousSummary?: string): string {
  const userAsks: string[] = [];
  const files = new Map<string, Set<string>>(); // path -> ops
  const commands: string[] = [];
  let lastAssistantText = "";

  for (const m of messages) {
    if (m.role === "user") {
      for (const b of m.content) {
        if (b.type === "text" && !b.text.startsWith(COMPACTION_PREFIX)) {
          userAsks.push(b.text);
        }
      }
      continue;
    }
    if (m.stopReason === "error" || m.stopReason === "aborted") continue;
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim() !== "") lastAssistantText = b.text.trim();
      if (b.type !== "tool_use") continue;
      const tu = b as ToolUseBlock;
      const path = typeof tu.input.path === "string" ? tu.input.path : null;
      if ((tu.name === "read" || tu.name === "edit" || tu.name === "write") && path !== null) {
        if (!files.has(path)) files.set(path, new Set());
        files.get(path)!.add(tu.name);
      } else if (tu.name === "bash" && typeof tu.input.command === "string") {
        commands.push(tu.input.command);
      }
    }
  }

  const sections: string[] = [];
  if (previousSummary !== undefined && previousSummary !== "") {
    sections.push("## Carried-over summary\n" + previousSummary);
  }
  sections.push(
    "## Task\n" + (userAsks.length > 0 ? userAsks.map((t) => "- " + clip(t, 500)).join("\n") : "(none recorded)"),
  );
  sections.push(
    "## Files touched\n" +
      (files.size > 0
        ? [...files.entries()].map(([p, ops]) => `- ${p} (${[...ops].sort().join(", ")})`).join("\n")
        : "(none)"),
  );
  const recentCommands = commands.slice(-15);
  sections.push(
    "## Commands run" +
      (commands.length > recentCommands.length ? ` (last ${recentCommands.length} of ${commands.length})` : "") +
      "\n" +
      (recentCommands.length > 0 ? recentCommands.map((c) => "- " + clip(c, 200)).join("\n") : "(none)"),
  );
  if (lastAssistantText !== "") {
    sections.push("## Last assistant note\n" + clip(lastAssistantText, 1_000));
  }
  return sections.join("\n\n");
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + " …";
}

const SUMMARIZE_INSTRUCTION =
  "Summarize the conversation above for continuation after context " +
  "compaction. Cover: the user's task and intent; work completed so far; " +
  "files touched and why; errors hit and how they were fixed; what is " +
  "verified working; what remains, with the concrete next step first. " +
  "If a carried-over summary is present, update it instead of restarting. " +
  "Be specific with paths and commands. Output only the summary.";

export type CompactOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  signal?: AbortSignal;
  /** Cap on summary output tokens. Callers with small context budgets MUST
   * lower this: a summary near the compact threshold defeats compaction by
   * construction (post-compact view instantly re-trips). */
  maxTokens?: number;
};

/** LLM summary with the deterministic emergency summary as fallback.
 * One attempt, no retry loops — compaction must never wedge a run. */
export async function summarize(
  messages: Message[],
  previousSummary: string | undefined,
  opts: CompactOptions,
): Promise<{ summary: string; llm: boolean }> {
  const emergency = emergencySummary(messages, previousSummary);
  const ask: Message = {
    role: "user",
    content: [{ type: "text", text: SUMMARIZE_INSTRUCTION }],
  };
  const res = await streamMessage({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    system: "You are a precise summarizer for coding-agent transcripts.",
    tools: [],
    messages: [...sanitizeForSummary(messages), ask],
    maxTokens: opts.maxTokens ?? SUMMARY_MAX_TOKENS,
    signal: opts.signal,
    maxAttempts: 2,
  });
  if (res.stopReason === "error" || res.stopReason === "aborted") {
    return { summary: emergency, llm: false };
  }
  const text = res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text === "" ? { summary: emergency, llm: false } : { summary: text, llm: true };
}

/** The summarizer call must not carry tool_use blocks (no tools are
 * offered, and a dangling tool_use would need a paired result). Project
 * tool calls and results into plain text. */
export function sanitizeForSummary(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.stopReason === "error" || m.stopReason === "aborted") continue;
      const parts: string[] = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push(b.text);
        else if (b.type === "tool_use") parts.push(`[called ${b.name}: ${clip(JSON.stringify(b.input), 300)}]`);
      }
      if (parts.length > 0) {
        out.push({
          role: "assistant",
          content: [{ type: "text", text: parts.join("\n") }],
          stopReason: "end_turn",
          usage: { inputFresh: 0, cacheRead: 0, output: 0 },
          apiMs: 0,
        });
      }
    } else {
      const parts: string[] = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push(b.text);
        else if (b.type === "tool_result") {
          const text = b.content.map((c) => c.text).join("\n");
          parts.push(`[tool result: ${clip(text, 600)}]`);
        }
      }
      if (parts.length > 0) {
        out.push({ role: "user", content: [{ type: "text", text: parts.join("\n") }] });
      }
    }
  }
  return out;
}

/** Retained tail: the longest recent slice that fits the envelope and
 * starts at a wire-valid boundary — a real user turn (text-carrying) or
 * an assistant message. Never a tool-result carrier: that would orphan
 * its tool_use pairing. Since the view opens with the summary user
 * message, an assistant-first tail is valid on the wire. */
export function retainedTail(messages: Message[], budgetTokens: number): Message[] {
  let best: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const validStart =
      m.role === "assistant"
        ? m.stopReason !== "error" && m.stopReason !== "aborted"
        : m.content.some((b) => b.type === "text");
    if (!validStart) continue;
    const tail = messages.slice(i);
    if (estimateTokens(JSON.stringify(tail)) > budgetTokens) break; // longer only grows
    best = tail;
  }
  return best;
}

/** Build the post-compaction view: one user message carrying the summary
 * plus the verbatim task pin, then the retained tail. */
export function compactedView(summary: string, task: string | undefined, tail: Message[]): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: buildCompactionText(summary, task) }] },
    ...tail,
  ];
}
