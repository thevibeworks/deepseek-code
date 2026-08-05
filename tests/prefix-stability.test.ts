// CI byte-compare test (DESIGN.md process rules): the serialized request
// prefix must be byte-identical across turns — appending a turn may only
// APPEND bytes to the payload, never change earlier ones. This is the
// prefix-cache invariant, enforced from day one.

import { describe, expect, test } from "bun:test";
import { buildPayload } from "../src/provider/client";
import type { AssistantMessage, Message } from "../src/provider/types";
import { buildSystemPrompt, toWireTools } from "../src/engine/prompt";
import { readTool } from "../src/tools/read";
import { bashTool } from "../src/tools/bash";
import { editTool } from "../src/tools/edit";
import { writeTool } from "../src/tools/write";

const tools = [readTool, bashTool, editTool, writeTool];

function payloadString(messages: Message[]): string {
  return JSON.stringify(
    buildPayload({
      apiKey: "k",
      baseUrl: "http://x",
      model: "deepseek-v4-flash",
      system: buildSystemPrompt(tools, "/work"),
      tools: toWireTools(tools),
      messages,
    }),
  );
}

const u1: Message = { role: "user", content: [{ type: "text", text: "fix the bug" }] };
const a1: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "look at the file" },
    { type: "text", text: "Reading it." },
    { type: "tool_use", id: "t1", name: "read", input: { path: "a.js" } },
  ],
  stopReason: "tool_use",
  usage: { inputFresh: 10, cacheRead: 0, output: 5 },
  apiMs: 100,
};
const u2: Message = {
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "var x" }] },
  ],
};

describe("prefix stability", () => {
  test("appending a turn only appends bytes", () => {
    const p1 = payloadString([u1]);
    const p2 = payloadString([u1, a1, u2]);
    // Same payload minus the closing "]}"... the shorter must be a strict
    // byte prefix of the longer once the array/object closers are dropped.
    const trimmed = p1.slice(0, p1.length - "]}".length);
    expect(p2.startsWith(trimmed)).toBe(true);
  });

  test("same messages give byte-identical payloads across calls", () => {
    const msgs: Message[] = [u1, a1, u2];
    expect(payloadString(msgs)).toBe(payloadString(msgs));
  });

  test("system prompt is deterministic and time-free", () => {
    const s1 = buildSystemPrompt(tools, "/work");
    const s2 = buildSystemPrompt(tools, "/work");
    expect(s1).toBe(s2);
    expect(s1.endsWith("Current working directory: /work")).toBe(true);
  });

  test("errored turns are scrubbed from the payload", () => {
    const errored: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stopReason: "error",
      errorMessage: "HTTP 500",
      usage: { inputFresh: 0, cacheRead: 0, output: 0 },
      apiMs: 1,
    };
    expect(payloadString([u1, errored])).toBe(payloadString([u1]));
  });

  test("agent-side fields never reach the wire", () => {
    const p = payloadString([u1, a1, u2]);
    for (const field of ["stopReason", "usage", "apiMs", "errorMessage", "inputInvalid"]) {
      expect(p.includes(field)).toBe(false);
    }
  });
});
