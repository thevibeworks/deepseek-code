// M3 units: compaction math + summaries + tail boundaries, session store
// roundtrip/rebuild, resume usage-zeroing (the autocompact-spiral
// trap). Live compaction behavior is exercised by the compaction eval.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCompactionText,
  COMPACTION_PREFIX,
  compactedView,
  compactThreshold,
  emergencySummary,
  retainedTail,
  sanitizeForSummary,
  TASK_PIN_PREFIX,
} from "../src/engine/compact";
import { SessionStore } from "../src/session/store";
import type { AssistantMessage, Message } from "../src/provider/types";

const asst = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "tool_use"): AssistantMessage => ({
  role: "assistant",
  content,
  stopReason,
  usage: { inputFresh: 100, cacheRead: 900, output: 50 },
  apiMs: 5,
});

const transcript: Message[] = [
  { role: "user", content: [{ type: "text", text: "fix the failing tests" }] },
  asst([
    { type: "text", text: "Looking around." },
    { type: "tool_use", id: "t1", name: "bash", input: { command: "node test/run.js" } },
  ]),
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "FAIL at 01" }] }] },
  asst([
    { type: "tool_use", id: "t2", name: "edit", input: { path: "src/csv.js", edits: [] } },
    { type: "tool_use", id: "t3", name: "read", input: { path: "src/dates.js" } },
  ]),
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Applied 1 edit(s)" }] },
      { type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: "const DAY_NAMES = [...]" }] },
    ],
  },
  asst([{ type: "text", text: "All fixed and verified." }], "end_turn"),
];

describe("compaction math", () => {
  test("threshold sits one reserve below the budget, floored", () => {
    expect(compactThreshold(616_000)).toBe(603_000);
    expect(compactThreshold(20_000)).toBe(7_000);
    expect(compactThreshold(5_000)).toBe(1_000);
  });
});

describe("emergencySummary", () => {
  test("is deterministic and captures task, files, commands", () => {
    const a = emergencySummary(transcript);
    const b = emergencySummary(transcript);
    expect(a).toBe(b);
    expect(a).toContain("fix the failing tests");
    expect(a).toContain("src/csv.js (edit)");
    expect(a).toContain("src/dates.js (read)");
    expect(a).toContain("node test/run.js");
    expect(a).toContain("All fixed and verified.");
  });

  test("carries the previous summary forward", () => {
    const s = emergencySummary(transcript, "earlier work happened");
    expect(s).toContain("Carried-over summary");
    expect(s).toContain("earlier work happened");
  });
});

describe("retainedTail", () => {
  test("never starts at a tool-result carrier", () => {
    const tail = retainedTail(transcript, 10_000);
    expect(tail.length).toBeGreaterThan(0);
    const first = tail[0];
    const isCarrier =
      first.role === "user" && first.content.some((b) => b.type === "tool_result");
    expect(isCarrier).toBe(false);
  });

  test("returns the longest slice that fits the budget", () => {
    const all = retainedTail(transcript, 1_000_000);
    expect(all.length).toBe(transcript.length);
    const none = retainedTail(transcript, 1);
    expect(none.length).toBe(0);
  });

  test("assistant-start tails keep tool pairing intact", () => {
    // Budget that fits the last 3 messages but not the whole transcript.
    const tail = retainedTail(transcript, 120);
    for (const [i, m] of tail.entries()) {
      if (m.role !== "user") continue;
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const prev = tail[i - 1];
        expect(prev).toBeDefined();
        expect(prev.role).toBe("assistant");
      }
    }
  });
});

describe("sanitizeForSummary", () => {
  test("projects tool blocks to text, drops none of the narrative", () => {
    const s = sanitizeForSummary(transcript);
    const flat = JSON.stringify(s);
    expect(flat).not.toContain('"tool_use"');
    expect(flat).not.toContain('"tool_result"');
    expect(flat).toContain("Looking around.");
    expect(flat).toContain("[called bash");
    expect(flat).toContain("[tool result: FAIL at 01");
  });
});

describe("SessionStore", () => {
  test("roundtrip, compaction rebuild, and resume usage-zeroing", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsc-store-test-"));
    const store = new SessionStore(join(dir, "s.db"));
    const meta = store.create("deepseek-v4-flash", "/work");

    for (const m of transcript) store.appendMessage(meta.id, m);
    const plain = store.rebuildView(meta.id);
    expect(plain.view.length).toBe(transcript.length);
    expect(plain.summary).toBeUndefined();
    // Resume trap: preserved assistant usage is zeroed.
    const preserved = plain.view.find((m) => m.role === "assistant") as AssistantMessage;
    expect(preserved.usage).toEqual({ inputFresh: 0, cacheRead: 0, output: 0 });

    // Compact: keep the last assistant message as the tail.
    const tail = [transcript[5]];
    store.appendCompaction(meta.id, {
      summary: "did the thing",
      llm: false,
      tail,
      task: "fix the failing tests",
    });
    const post: Message = { role: "user", content: [{ type: "text", text: "now do more" }] };
    store.appendMessage(meta.id, post);

    const rebuilt = store.rebuildView(meta.id);
    expect(rebuilt.summary).toBe("did the thing");
    expect(rebuilt.view.length).toBe(3); // summary msg + tail + post
    const first = rebuilt.view[0];
    expect(first.role).toBe("user");
    expect((first.content[0] as any).text).toBe(
      buildCompactionText("did the thing", "fix the failing tests"),
    );
    expect(JSON.stringify(rebuilt.view[2])).toContain("now do more");

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("compactedView", () => {
  test("opens with one user message: summary first, task pinned last", () => {
    const v = compactedView("sum", "the original ask", [transcript[5]]);
    expect(v.length).toBe(2);
    expect(v[0].role).toBe("user");
    const text = (v[0].content[0] as any).text;
    expect(text).toBe(COMPACTION_PREFIX + "sum\n\n" + TASK_PIN_PREFIX + "the original ask");
    // The verbatim task must survive EVERY compaction round — summaries
    // erode, the pin does not.
    expect(text.indexOf("sum")).toBeLessThan(text.indexOf("the original ask"));
  });

  test("no task -> plain summary message, no pin header", () => {
    const v = compactedView("sum", undefined, []);
    expect((v[0].content[0] as any).text).toBe(COMPACTION_PREFIX + "sum");
  });

  test("compaction message is never counted as a user ask by the emergency summary", () => {
    const withPin: Message[] = [
      { role: "user", content: [{ type: "text", text: buildCompactionText("old sum", "real task") }] },
      transcript[5],
    ];
    const s = emergencySummary(withPin);
    expect(s).toContain("(none recorded)");
  });
});
