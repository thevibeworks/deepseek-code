// M2 context engine units: spill, preview, meter, doom-loop key, reclaim
// projection. Loop wiring for the guards is exercised by the eval suite.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPILL_BYTES } from "../src/tools/truncate";
import { OutputAccumulator } from "../src/tools/accumulator";
import { bashTool } from "../src/tools/bash";
import { ContextMeter, estimateTokens } from "../src/engine/context";
import { batchKey } from "../src/engine/loop";
import { RECLAIMED_TEXT, toWire } from "../src/provider/client";
import type { Message } from "../src/provider/types";

describe("OutputAccumulator", () => {
  test("spills mid-stream at the limit and keeps a bounded rolling tail", async () => {
    const spillDir = mkdtempSync(join(tmpdir(), "dsc-acc-test-"));
    const acc = new OutputAccumulator(spillDir, "test");
    const chunk = "0123456789".repeat(1000) + "\n"; // ~10 KB per chunk
    for (let i = 0; i < 20; i++) acc.add(`chunk-${i}\n` + chunk);
    const r = acc.finalize();
    if (!r.spilled) throw new Error("expected spill");
    expect(r.bytes).toBeGreaterThan(SPILL_BYTES);
    const full = readFileSync(r.path, "utf8");
    expect(Buffer.byteLength(full, "utf8")).toBe(r.bytes);
    expect(full).toContain("chunk-0");
    expect(full).toContain("chunk-19");
    expect(r.text).toContain("chunk-0");
    expect(r.text).toContain("[...]");
    expect(r.text.length).toBeLessThan(5000);
    rmSync(spillDir, { recursive: true, force: true });
  });

  test("small output stays in memory untouched", async () => {
    const acc = new OutputAccumulator(undefined, "test");
    acc.add("hello ");
    acc.add("world");
    expect(acc.finalize()).toEqual({ spilled: false, text: "hello world" });
  });

  test("a single chunk larger than the limit still yields head and tail", () => {
    const spillDir = mkdtempSync(join(tmpdir(), "dsc-acc-test-"));
    const acc = new OutputAccumulator(spillDir, "test");
    const lines = Array.from({ length: 15000 }, (_, i) => `only-${i}`);
    acc.add(lines.join("\n")); // ~165 KB in one add()
    const r = acc.finalize();
    if (!r.spilled) throw new Error("expected spill");
    expect(r.text).toContain("only-0");
    expect(r.text).toContain("only-14999");
    rmSync(spillDir, { recursive: true, force: true });
  });
});

describe("bash spill", () => {
  test("output over SPILL_BYTES is spilled losslessly with a preview", async () => {
    const spillDir = mkdtempSync(join(tmpdir(), "dsc-spill-test-"));
    const n = 6000; // 6000 numbered ~20-byte lines ≈ 120 KB > SPILL_BYTES
    const r = await bashTool.execute(
      { command: `seq -f "spilled-line-%.0f" ${n}` },
      { cwd: tmpdir(), spillDir },
    );
    expect(r.isError ?? false).toBe(false);
    expect(r.output).toContain("full output saved to ");
    expect(r.output).toContain("spilled-line-1");
    expect(r.output).toContain(`spilled-line-${n}`);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThan(6000);
    const path = r.output.match(/saved to (\S+)\./)![1];
    const full = readFileSync(path, "utf8");
    expect(Buffer.byteLength(full, "utf8")).toBeGreaterThan(SPILL_BYTES);
    expect(full).toContain(`spilled-line-${n / 2}`);
    rmSync(spillDir, { recursive: true, force: true });
  });

  test("output under the threshold is not spilled", async () => {
    const spillDir = mkdtempSync(join(tmpdir(), "dsc-spill-test-"));
    const r = await bashTool.execute(
      { command: "echo small" },
      { cwd: tmpdir(), spillDir },
    );
    expect(r.output).toBe("small\n");
    rmSync(spillDir, { recursive: true, force: true });
  });
});

describe("ContextMeter", () => {
  test("anchors on provider usage and estimates the trailing delta", () => {
    const m = new ContextMeter();
    expect(m.estimate()).toBe(0);
    m.onAssistantUsage({ inputFresh: 1000, cacheRead: 9000, output: 500 });
    expect(m.estimate()).toBe(10500);
    m.onAppended("x".repeat(400));
    expect(m.estimate()).toBe(10600);
    // Re-anchoring resets the delta.
    m.onAssistantUsage({ inputFresh: 100, cacheRead: 10600, output: 50 });
    expect(m.estimate()).toBe(10750);
  });

  test("estimateTokens is len/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("doom-loop batch key", () => {
  test("same names and inputs collide, different inputs do not", () => {
    const a = batchKey([
      { type: "tool_use", id: "1", name: "bash", input: { command: "node test.js" } },
    ]);
    const b = batchKey([
      { type: "tool_use", id: "2", name: "bash", input: { command: "node test.js" } },
    ]);
    const c = batchKey([
      { type: "tool_use", id: "3", name: "bash", input: { command: "ls" } },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("reclaim projection", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      stopReason: "tool_use",
      usage: { inputFresh: 1, cacheRead: 0, output: 1 },
      apiMs: 1,
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "big output" }] },
      ],
    },
  ];

  test("no reclaim set means byte-identical wire output", () => {
    expect(JSON.stringify(toWire(messages))).toBe(
      JSON.stringify(toWire(messages, new Set())),
    );
  });

  test("reclaimed ids render as stubs; originals stay untouched", () => {
    const wire = toWire(messages, new Set(["t1"])) as any[];
    expect(JSON.stringify(wire[2])).toContain(RECLAIMED_TEXT);
    expect(JSON.stringify(wire[2])).not.toContain("big output");
    // Transcript message object is not mutated (lossless reclaim).
    expect(JSON.stringify(messages[2])).toContain("big output");
  });
});
