// Agent loop. Contracts vendored from pi-mono's agent-loop (MIT,
// attribution: Mario Zechner / pi-mono; see docs/research/
// pi-loop-tools-skills.md):
// - stopReason "length" with tool calls fails EVERY call in the batch
//   (truncated args can parse yet be incomplete) with a re-issue error;
//   the run continues so the model can retry with complete arguments.
// - Tool result messages are appended in assistant source order.
// - The stream client never throws; errored/aborted turns stay in the
//   transcript but are scrubbed from provider payloads (client.toWire).
// - Session-level retry OUTSIDE the streaming call: retryable errored
//   turns are retried with abortable 2s*2^n backoff.
// History is append-only; message objects are immutable once appended —
// prefix-cache byte stability holds by construction.

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ToolResultBlock, ToolUseBlock, Usage } from "../provider/types";
import { addUsage, zeroUsage } from "../provider/types";
import { streamMessage } from "../provider/client";
import type { ToolContext, ToolDefinition } from "../tools/index";
import { validateInput } from "../tools/index";
import { buildSystemPrompt, toWireTools } from "./prompt";
import { ContextMeter, estimateTokens } from "./context";
import {
  compactedView,
  compactThreshold,
  POST_COMPACT_ENVELOPE_TOKENS,
  retainedTail,
  summarize,
} from "./compact";
import type { AgentEvent, EventSink } from "./events";

export type CompactionInfo = {
  summary: string;
  llm: boolean;
  /** The run's task prompt, pinned verbatim in the compacted view. */
  task: string;
  /** Number of trailing view messages retained after the summary. */
  keptTail: number;
  contextTokensBefore: number;
};

export type RunOptions = {
  prompt: string;
  model: string;
  cwd: string;
  apiKey: string;
  baseUrl: string;
  tools: ToolDefinition[];
  maxTurns?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: EventSink;
  /** Existing context view to continue from (session resume / multi-run).
   * The loop appends to this array in place. */
  messages?: Message[];
  /** Usable input budget in tokens; when set, the loop autocompacts at
   * compactThreshold(budget). Unset = no autocompaction. */
  contextBudget?: number;
  /** Summary carried from a previous compaction, updated by the next. */
  previousSummary?: string;
  /** Tool results from finished runs, rendered as reclaimed stubs. */
  reclaimIds?: Set<string>;
  /** Persistence hook: called for every message appended to the view. */
  onMessage?: (m: Message) => void;
  /** Persistence hook: called when the loop compacts the view. */
  onCompaction?: (info: CompactionInfo) => void;
};

export type RunResult = {
  messages: Message[];
  turns: number;
  usage: Usage;
  apiMs: number;
  resultText: string;
  endReason: "completed" | "error" | "aborted" | "max_turns";
  errorMessage?: string;
  compactions: number;
};

const MAX_SESSION_RETRIES = 3;
const NON_RETRYABLE =
  /invalid.?api.?key|authentication|unauthorized|forbidden|billing|insufficient|quota|balance|\b40[13]\b/i;

// Repetition killers (DESIGN.md context engine #5). Both are append-only:
// they change what NEW results say, never already-sent bytes.

/** Canonical identity of a tool batch, for doom-loop detection. */
export function batchKey(toolUses: ToolUseBlock[]): string {
  return JSON.stringify(toolUses.map((tu) => [tu.name, tu.input]));
}

/** A batch identical to the previous two turns' batches is a doom loop:
 * one identical retry is allowed (transient failures are real), the third
 * consecutive issue short-circuits. */
export const DOOM_LOOP_AT = 3;

export const DOOM_LOOP_TEXT =
  "This exact tool batch has been issued on three consecutive turns with " +
  "nothing changing in between, so it was not executed again. Change your " +
  "approach: inspect something different or make a different edit before " +
  "retrying.";

/** Stands in for tool calls that a cancelled batch never ran. The model
 * reads this on the next turn of a resumed session, so it says what
 * happened rather than looking like a tool failure. */
export const INTERRUPTED_TEXT =
  "The user interrupted this run before this tool call was executed. " +
  "It did not run and had no effect.";

export const READ_DEDUP_TEXT =
  "[Unchanged since your previous read of this file — identical content " +
  "elided. Scroll up to your earlier read for the contents.]";

/** The named between-turns seam (Round 4 delta #4, pi's prepareNextTurn /
 * shouldStopAfterTurn). Everything that acts "between turns" — today the
 * doom-loop skip; later the autocompact trigger, budget envelopes,
 * steering injection, model arming — inserts HERE, not in the loop body. */
export class TurnSeam {
  private lastBatchKey = "";
  private batchRepeats = 0;

  /** Runs after each assistant turn, before tool execution. Returns
   * short-circuit results to append instead of executing, or null. */
  prepareNextTurn(toolUses: ToolUseBlock[]): ToolResultBlock[] | null {
    const key = batchKey(toolUses);
    this.batchRepeats = key === this.lastBatchKey ? this.batchRepeats + 1 : 1;
    this.lastBatchKey = key;
    if (this.batchRepeats < DOOM_LOOP_AT) return null;
    return toolUses.map((tu) => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: [{ type: "text", text: DOOM_LOOP_TEXT }],
      is_error: true,
    }));
  }
}

export async function runLoop(opts: RunOptions): Promise<RunResult> {
  const emit: EventSink = opts.onEvent ?? (() => {});
  const maxTurns = opts.maxTurns ?? 100;
  const system = buildSystemPrompt(opts.tools, opts.cwd);
  const wireTools = toWireTools(opts.tools);
  const toolCtx: ToolContext = {
    cwd: opts.cwd,
    spillDir: join(tmpdir(), `dsc-spill-${process.pid}`),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  const meter = new ContextMeter();
  const seam = new TurnSeam();
  const readSeen = new Map<string, bigint>();
  const onMessage = opts.onMessage ?? (() => {});

  const messages: Message[] = opts.messages ?? [];
  const userMsg: Message = { role: "user", content: [{ type: "text", text: opts.prompt }] };
  messages.push(userMsg);
  onMessage(userMsg);
  // Prime the meter with the pre-run view so the first autocompact
  // decision on a resumed session is not based on an empty anchor.
  meter.onAppended(JSON.stringify(messages));

  let turns = 0;
  let usage = zeroUsage();
  let apiMs = 0;
  let retries = 0;
  let compactions = 0;
  let previousSummary = opts.previousSummary;

  emit({ type: "agent_start", model: opts.model });

  const finish = (
    endReason: RunResult["endReason"],
    errorMessage?: string,
  ): RunResult => {
    emit({ type: "agent_end", reason: endReason });
    return {
      messages,
      turns,
      usage,
      apiMs,
      resultText: lastAssistantText(messages),
      endReason,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      compactions,
    };
  };

  // Autocompact (between-turns work, DESIGN.md context engine #7): runs
  // in the seam position after tool results land, at most once per turn.
  const systemOverhead = estimateTokens(system + JSON.stringify(wireTools));
  const maybeCompact = async (): Promise<void> => {
    if (opts.contextBudget === undefined) return;
    const before = meter.estimate();
    const threshold = compactThreshold(opts.contextBudget);
    if (before <= threshold) return;
    const { summary, llm } = await summarize(messages, previousSummary, {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      // A summary near the threshold defeats compaction by construction —
      // cap it at a quarter of the threshold on small budgets.
      maxTokens: Math.max(512, Math.min(4_096, Math.floor(threshold / 4))),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    // Tail budget: the design envelope, but never more than half the
    // threshold — a post-compaction view near the threshold would
    // re-trigger every turn and thrash.
    const tailBudget = Math.max(
      Math.min(POST_COMPACT_ENVELOPE_TOKENS, Math.floor(threshold / 2)) - systemOverhead,
      1_000,
    );
    const tail = retainedTail(messages, tailBudget);
    const view = compactedView(summary, opts.prompt, tail);
    messages.length = 0;
    messages.push(...view);
    previousSummary = summary;
    compactions++;
    // Read-dedup anchors died with the old view: a re-read after
    // compaction must return real content, not "scroll up".
    readSeen.clear();
    meter.reset(JSON.stringify(messages).length);
    emit({ type: "compaction", llm, contextTokensBefore: before, contextTokensAfter: meter.estimate() });
    opts.onCompaction?.({ summary, llm, task: opts.prompt, keptTail: tail.length, contextTokensBefore: before });
  };

  while (true) {
    if (turns >= maxTurns) return finish("max_turns");
    emit({ type: "turn_start", turn: turns + 1 });

    const assistant = await streamMessage({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      system,
      tools: wireTools,
      messages,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      onEvent: (e) => emit(e as AgentEvent),
      reclaimIds: opts.reclaimIds,
    });
    apiMs += assistant.apiMs;
    usage = addUsage(usage, assistant.usage);
    meter.onAssistantUsage(assistant.usage);
    messages.push(assistant);
    onMessage(assistant);
    emit({ type: "message_end", message: assistant });

    if (assistant.stopReason === "aborted") return finish("aborted", assistant.errorMessage);
    if (assistant.stopReason === "error") {
      // Errored turn stays in the transcript; toWire drops it from payloads.
      if (retries >= MAX_SESSION_RETRIES || NON_RETRYABLE.test(assistant.errorMessage ?? "")) {
        return finish("error", assistant.errorMessage);
      }
      await abortableSleep(2000 * 2 ** retries, opts.signal);
      retries++;
      continue;
    }
    retries = 0;
    turns++;

    const toolUses = assistant.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    if (assistant.stopReason === "length" && toolUses.length > 0) {
      // Length-poisoned batch: fail every call, let the model re-issue.
      const results: ToolResultBlock[] = toolUses.map((tu) => ({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [
          {
            type: "text",
            text:
              "The response hit the output-token limit, so this tool call " +
              "may have incomplete arguments and was not executed. Re-issue " +
              "the call with complete arguments.",
          },
        ],
        is_error: true,
      }));
      const lp: Message = { role: "user", content: results };
      messages.push(lp);
      onMessage(lp);
      for (const r of results) meter.onAppended(r.content[0].text);
      emit({ type: "turn_end", turn: turns, usage: assistant.usage, contextTokens: meter.estimate() });
      continue;
    }

    if (toolUses.length === 0) {
      emit({ type: "turn_end", turn: turns, usage: assistant.usage, contextTokens: meter.estimate() });
      return finish("completed");
    }

    const shortCircuit = seam.prepareNextTurn(toolUses);
    if (shortCircuit !== null) {
      const sc: Message = { role: "user", content: shortCircuit };
      messages.push(sc);
      onMessage(sc);
      for (const r of shortCircuit) meter.onAppended(r.content[0].text);
      emit({ type: "turn_end", turn: turns, usage: assistant.usage, contextTokens: meter.estimate() });
      continue;
    }

    // Execute sequentially in source order; results appended in source order.
    const results: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      // Cancellation stops the batch, but EVERY tool_use still gets a
      // paired result — an unpaired tool_use is an invalid payload, and
      // the interrupted view has to stay resumable.
      if (opts.signal?.aborted === true) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: [{ type: "text", text: INTERRUPTED_TEXT }],
          is_error: true,
        });
        continue;
      }
      emit({ type: "tool_execution_start", id: tu.id, name: tu.name, input: tu.input });
      const r = await executeToolCall(tu, toolMap, toolCtx);
      let output = r.output;
      // Read-dedup: an identical re-read of identical content is elided —
      // the bytes are already in context from the earlier read.
      if (tu.name === "read" && r.isError !== true) {
        const readKey = JSON.stringify([tu.input.path, tu.input.offset, tu.input.limit]);
        const hash = Bun.hash(output) as bigint;
        if (readSeen.get(readKey) === hash) output = READ_DEDUP_TEXT;
        else readSeen.set(readKey, hash);
      }
      emit({ type: "tool_execution_end", id: tu.id, output, isError: r.isError });
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [{ type: "text", text: output }],
        ...(r.isError ? { is_error: true } : {}),
      });
      meter.onAppended(output);
    }
    const resultsMsg: Message = { role: "user", content: results };
    messages.push(resultsMsg);
    onMessage(resultsMsg);
    if (opts.signal?.aborted === true) {
      emit({ type: "turn_end", turn: turns, usage: assistant.usage, contextTokens: meter.estimate() });
      return finish("aborted");
    }
    await maybeCompact();
    emit({ type: "turn_end", turn: turns, usage: assistant.usage, contextTokens: meter.estimate() });
  }
}

async function executeToolCall(
  tu: ToolUseBlock,
  toolMap: Map<string, ToolDefinition>,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  if (tu.inputInvalid !== undefined) {
    return {
      output:
        "Tool call arguments were not valid JSON and were not executed. " +
        "Re-issue the call with valid JSON arguments.",
      isError: true,
    };
  }
  const tool = toolMap.get(tu.name);
  if (!tool) {
    return {
      output: `Unknown tool "${tu.name}". Available tools: ${[...toolMap.keys()].join(", ")}.`,
      isError: true,
    };
  }
  let input = tu.input;
  try {
    if (tool.coerce) input = tool.coerce(input);
    const problems = validateInput(input, tool.inputSchema);
    if (problems.length > 0) {
      return {
        output: `Invalid arguments for ${tool.name}:\n- ${problems.join("\n- ")}`,
        isError: true,
      };
    }
    const r = await tool.execute(input, ctx);
    return { output: r.output, isError: r.isError ?? false };
  } catch (err) {
    return { output: `Tool ${tool.name} failed: ${String(err)}`, isError: true };
  }
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (m.stopReason === "error" || m.stopReason === "aborted") continue;
    return m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
