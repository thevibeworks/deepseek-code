// Anthropic-protocol client for DeepSeek's /anthropic endpoint.
// Own wire code, zero vendor SDKs (DESIGN.md provider layer).
//
// Contracts vendored from pi-mono's loop design (docs/research/
// pi-loop-tools-skills.md, MIT, attribution: Mario Zechner / pi-mono):
// - streamMessage NEVER throws: failures come back as an AssistantMessage
//   with stopReason "error" | "aborted" + errorMessage.
// - Transport retry lives here, OUTSIDE the agent loop: 408/409/429/5xx,
//   Retry-After honored (capped 60s), exp backoff min(0.5*2^n, 8)s + jitter.
// - toWire() is a pure function of immutable messages: same objects in,
//   same bytes out — the prefix-cache invariant is by construction.
//   Errored/aborted assistant turns are scrubbed from the payload so
//   crashed turns never poison replay.

import type {
  AssistantContent,
  AssistantMessage,
  Message,
  StopReason,
  ThinkingBlock,
  TextBlock,
  ToolUseBlock,
  Usage,
  WireTool,
} from "./types";
import { zeroUsage } from "./types";
import { healDsml } from "./dsml";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string };

export type StreamOpts = {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  tools: WireTool[];
  messages: Message[];
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (e: StreamEvent) => void;
  maxAttempts?: number;
  /** Tool results to render as reclaimed stubs; set only at run boundaries. */
  reclaimIds?: Set<string>;
};

const DEFAULT_MAX_TOKENS = 65_536;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export const RECLAIMED_TEXT =
  "[Tool result reclaimed at run end to free context. Re-run the tool if " +
  "the output is needed again.]";

/** Pure conversion: internal messages -> Anthropic wire messages.
 * Skips errored/aborted assistant turns; strips agent-side fields.
 * reclaimIds (DESIGN.md context engine #3): tool results from finished
 * runs render as a stub — lossless because the transcript keeps the
 * originals. Only ever called with ids at a run boundary: rewriting
 * results mid-run would break the prefix cache every turn. */
export function toWire(messages: Message[], reclaimIds?: Set<string>): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.stopReason === "error" || m.stopReason === "aborted") continue;
      out.push({
        role: "assistant",
        content: m.content.map(wireBlock),
      });
    } else if (reclaimIds !== undefined && reclaimIds.size > 0) {
      out.push({
        role: "user",
        content: m.content.map((b) =>
          b.type === "tool_result" && reclaimIds.has(b.tool_use_id)
            ? { ...b, content: [{ type: "text", text: RECLAIMED_TEXT }] }
            : b,
        ),
      });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

function wireBlock(b: AssistantContent): unknown {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      // Exact replay of thinking content (the /anthropic analogue of the
      // native protocol's reasoning_content replay requirement).
      return b.signature !== undefined
        ? { type: "thinking", thinking: b.thinking, signature: b.signature }
        : { type: "thinking", thinking: b.thinking };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  }
}

export function buildPayload(opts: StreamOpts): Record<string, unknown> {
  // messages stays LAST so each appended turn only appends bytes to the
  // serialized body (see tests/prefix-stability.test.ts).
  return {
    model: opts.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    system: opts.system,
    tools: opts.tools,
    messages: toWire(opts.messages, opts.reclaimIds),
  };
}

export async function streamMessage(opts: StreamOpts): Promise<AssistantMessage> {
  const t0 = Date.now();
  const maxAttempts = opts.maxAttempts ?? 4;
  const body = JSON.stringify(buildPayload(opts));

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) return failed("aborted", "request aborted", t0);
      if (attempt + 1 < maxAttempts) {
        await backoff(attempt, null, opts.signal);
        continue;
      }
      return failed("error", `fetch failed: ${String(err)}`, t0);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (RETRYABLE_STATUS.has(res.status) && attempt + 1 < maxAttempts) {
        const ra = retryAfterMs(res);
        if (ra !== null && ra > 60_000) {
          return failed("error", `HTTP ${res.status}, Retry-After ${ra}ms exceeds 60s cap: ${text.slice(0, 500)}`, t0);
        }
        await backoff(attempt, ra, opts.signal);
        continue;
      }
      return failed("error", `HTTP ${res.status}: ${text.slice(0, 2000)}`, t0);
    }

    return await consumeStream(res, opts, t0);
  }
}

function failed(reason: StopReason, msg: string, t0: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: reason,
    errorMessage: msg,
    usage: zeroUsage(),
    apiMs: Date.now() - t0,
  };
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const s = Number(h);
  return Number.isFinite(s) ? s * 1000 : null;
}

async function backoff(attempt: number, retryAfterMs: number | null, signal?: AbortSignal): Promise<void> {
  const base = retryAfterMs ?? Math.min(500 * 2 ** attempt, 8000);
  const ms = base + Math.random() * 250;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

// --- SSE stream state machine ---

type PartialBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature?: string }
  | { kind: "tool_use"; id: string; name: string; json: string };

async function consumeStream(
  res: Response,
  opts: StreamOpts,
  t0: number,
): Promise<AssistantMessage> {
  const usage: Usage = zeroUsage();
  const blocks = new Map<number, PartialBlock>();
  const order: number[] = [];
  let stopReason: StopReason = "end_turn";
  let errorMessage: string | undefined;

  try {
    for await (const ev of sseEvents(res.body!)) {
      const d = ev.data;
      switch (d.type) {
        case "message_start": {
          const u = d.message?.usage ?? {};
          usage.inputFresh = u.input_tokens ?? 0;
          usage.cacheRead = u.cache_read_input_tokens ?? 0;
          usage.output = u.output_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const cb = d.content_block;
          const idx = d.index as number;
          order.push(idx);
          if (cb.type === "text") blocks.set(idx, { kind: "text", text: cb.text ?? "" });
          else if (cb.type === "thinking")
            blocks.set(idx, { kind: "thinking", thinking: cb.thinking ?? "" });
          else if (cb.type === "tool_use")
            blocks.set(idx, { kind: "tool_use", id: cb.id, name: cb.name, json: "" });
          break;
        }
        case "content_block_delta": {
          const b = blocks.get(d.index as number);
          if (!b) break;
          const delta = d.delta;
          if (delta.type === "text_delta" && b.kind === "text") {
            b.text += delta.text;
            opts.onEvent?.({ type: "text_delta", text: delta.text });
          } else if (delta.type === "thinking_delta" && b.kind === "thinking") {
            b.thinking += delta.thinking;
            opts.onEvent?.({ type: "thinking_delta", text: delta.thinking });
          } else if (delta.type === "signature_delta" && b.kind === "thinking") {
            b.signature = (b.signature ?? "") + delta.signature;
          } else if (delta.type === "input_json_delta" && b.kind === "tool_use") {
            b.json += delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          if (d.delta?.stop_reason) stopReason = mapStopReason(d.delta.stop_reason);
          if (d.usage?.output_tokens !== undefined) usage.output = d.usage.output_tokens;
          break;
        }
        case "error": {
          stopReason = "error";
          errorMessage = `stream error: ${d.error?.type ?? "unknown"}: ${d.error?.message ?? ""}`;
          break;
        }
        // message_stop, ping, content_block_stop: no state to update
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      stopReason = "aborted";
      errorMessage = "request aborted";
    } else {
      stopReason = "error";
      errorMessage = `stream read failed: ${String(err)}`;
    }
  }

  const content = finalizeBlocks(blocks, order);
  if (content.some((b) => b.type === "tool_use") && stopReason === "end_turn") {
    stopReason = "tool_use";
  }
  return {
    role: "assistant",
    content,
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    usage,
    apiMs: Date.now() - t0,
  };
}

let dsmlCallCounter = 0;

function finalizeBlocks(
  blocks: Map<number, PartialBlock>,
  order: number[],
): AssistantContent[] {
  const content: AssistantContent[] = [];
  for (const idx of order) {
    const b = blocks.get(idx)!;
    if (b.kind === "thinking") {
      const t: ThinkingBlock = { type: "thinking", thinking: b.thinking };
      if (b.signature !== undefined) t.signature = b.signature;
      content.push(t);
    } else if (b.kind === "tool_use") {
      const t: ToolUseBlock = { type: "tool_use", id: b.id, name: b.name, input: {} };
      if (b.json.trim() !== "") {
        try {
          t.input = JSON.parse(b.json);
        } catch {
          t.inputInvalid = b.json;
        }
      }
      content.push(t);
    } else {
      // Heal DSML envelopes leaked into visible text into real tool calls.
      const { text, calls } = healDsml(b.text);
      if (text.trim() !== "" || calls.length === 0) {
        const tb: TextBlock = { type: "text", text };
        content.push(tb);
      }
      for (const c of calls) {
        content.push({
          type: "tool_use",
          id: `dsml_${++dsmlCallCounter}_${Math.random().toString(16).slice(2, 10)}`,
          name: c.name,
          input: c.input,
        });
      }
    }
  }
  return content;
}

function mapStopReason(s: string): StopReason {
  switch (s) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    case "max_tokens":
      return "length";
    default:
      return "end_turn";
  }
}

// Minimal SSE parser: yields parsed JSON data payloads.
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: any }> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = "";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data === "" || data === "[DONE]") continue;
      try {
        yield { event, data: JSON.parse(data) };
      } catch {
        // skip unparseable frame
      }
    }
  }
}
