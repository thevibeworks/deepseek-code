// Interrupting a run must leave a RESUMABLE view. The trap: toWire() drops
// aborted/errored assistant turns, so any tool_result left behind by a
// half-executed batch would become an orphan with no matching tool_use —
// an invalid payload on the very next prompt.
//
// Driven by a local SSE server speaking the Anthropic protocol, so the
// timing is deterministic and no tokens are spent.

import { afterAll, describe, expect, test } from "bun:test";
import { runLoop } from "../src/engine/loop";
import { toWire } from "../src/provider/client";
import { bashTool } from "../src/tools/bash";
import type { Message, ToolUseBlock } from "../src/provider/types";

function sse(events: unknown[]): string {
  return events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** One assistant turn calling bash twice — enough that an abort can land
 * between the two calls. `slow` blocks long enough to be interrupted;
 * `fast` is the same shape with nothing to wait for. */
function twoCallTurn(firstCommand: string): string {
  return TWO_CALL_TURN.replace("sleep 20 && echo a", firstCommand);
}

const TWO_CALL_TURN = sse([
  { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_a", name: "bash" } },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 20 && echo a" }) },
  },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_b", name: "bash" } },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo b" }) },
  },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
]);

const server = Bun.serve({
  port: 0,
  fetch: (req) =>
    new Response(new URL(req.url).pathname.startsWith("/fast") ? twoCallTurn("echo a") : TWO_CALL_TURN, {
      headers: { "content-type": "text/event-stream" },
    }),
});
const baseUrl = `http://localhost:${server.port}/slow`;
const fastBaseUrl = `http://localhost:${server.port}/fast`;

afterAll(() => server.stop(true));

const base = {
  model: "deepseek-v4-flash",
  cwd: process.cwd(),
  apiKey: "test",
  baseUrl,
  tools: [bashTool],
  maxTurns: 3,
};

/** Every tool_use in the view must have a tool_result with a matching id,
 * counting only messages that survive toWire. */
function unpairedToolUses(messages: Message[]): string[] {
  const wire = toWire(messages) as { role: string; content: any[] }[];
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of wire) {
    for (const b of m.content ?? []) {
      if (b.type === "tool_use") uses.add(b.id);
      if (b.type === "tool_result") results.add(b.tool_use_id);
    }
  }
  return [...uses].filter((id) => !results.has(id)).concat([...results].filter((id) => !uses.has(id)));
}

describe("interrupting a run", () => {
  test("aborting mid-batch still pairs every tool call, and returns fast", async () => {
    const ac = new AbortController();
    // Anchored to the event, not a timer: a fixed delay can land during
    // streaming instead of during tool execution and silently test
    // nothing. Abort once the first (20s) command is actually running.
    const t0 = Date.now();
    const result = await runLoop({
      ...base,
      prompt: "go",
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "tool_execution_start" && e.id === "call_a") setTimeout(() => ac.abort(), 100);
      },
    });
    const elapsed = Date.now() - t0;

    expect(result.endReason).toBe("aborted");
    expect(elapsed).toBeLessThan(8_000);
    expect(unpairedToolUses(result.messages)).toEqual([]);

    // The second call never ran, but is still answered.
    const stub = result.messages
      .flatMap((m) => (m.role === "user" ? m.content : []))
      .find((b: any) => b.type === "tool_result" && b.tool_use_id === "call_b") as any;
    expect(stub).toBeDefined();
    expect(stub.is_error).toBe(true);
    expect(stub.content[0].text).toContain("interrupted");
  }, 30_000);

  test("the interrupted view is a valid prefix for the next prompt", async () => {
    const abortOnFirstTool = (ac: AbortController) => (e: { type: string }) => {
      if (e.type === "tool_execution_start") setTimeout(() => ac.abort(), 100);
    };
    const ac = new AbortController();
    const messages: Message[] = [];
    await runLoop({ ...base, prompt: "first", signal: ac.signal, messages, onEvent: abortOnFirstTool(ac) });

    // What the REPL does next: append a new user turn to the same view.
    const before = messages.length;
    const ac2 = new AbortController();
    await runLoop({ ...base, prompt: "second", signal: ac2.signal, messages, onEvent: abortOnFirstTool(ac2) });

    expect(messages.length).toBeGreaterThan(before);
    expect(unpairedToolUses(messages)).toEqual([]);
    // Consecutive user messages are what an interrupted turn produces; the
    // /anthropic endpoint accepts them (verified live against the API).
    const wire = toWire(messages) as { role: string }[];
    expect(wire.length).toBeGreaterThan(0);
  }, 30_000);

  test("an uninterrupted run executes the whole batch", async () => {
    const messages: Message[] = [];
    const result = await runLoop({
      ...base,
      baseUrl: fastBaseUrl,
      prompt: "go",
      maxTurns: 1,
      messages,
    });
    // maxTurns stops it; what matters is both calls got real results.
    const texts = messages
      .flatMap((m) => (m.role === "user" ? m.content : []))
      .filter((b: any) => b.type === "tool_result")
      .map((b: any) => b.content[0].text);
    expect(texts.some((t) => t.includes("interrupted"))).toBe(false);
    expect(result.endReason).toBe("max_turns");
  }, 60_000);
});
