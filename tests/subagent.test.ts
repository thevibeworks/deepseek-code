// Sub-agent lifecycle tests: stub runner, no network. What matters:
// spawn is non-blocking (parallelism exists), budgets kill quietly with a
// partial report, cancel works, usage totals include every child, and the
// task tool's action surface maps onto the manager correctly.

import { describe, expect, test } from "bun:test";
import type { RunOptions, RunResult } from "../src/engine/loop";
import {
  MAX_CHILDREN,
  renderReport,
  ROLES,
  SubagentManager,
} from "../src/engine/subagent";
import { makeTaskTool } from "../src/tools/task";

const CFG = { apiKey: "k", baseUrl: "http://x", cwd: "/work" };

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    messages: [],
    turns: 3,
    usage: { inputFresh: 1000, cacheRead: 2000, output: 500 },
    apiMs: 10,
    resultText: "report text",
    endReason: "completed",
    compactions: 0,
    ...over,
  };
}

/** Runner stub: records opts, resolves when told to (or immediately). */
function makeStub() {
  const calls: RunOptions[] = [];
  const resolvers: Array<(r: RunResult) => void> = [];
  const runFn = (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return new Promise((resolve) => {
      resolvers.push(resolve);
      opts.signal?.addEventListener(
        "abort",
        () => resolve(result({ endReason: "aborted", resultText: "partial notes" })),
        { once: true },
      );
    });
  };
  return { calls, resolvers, runFn };
}

describe("SubagentManager", () => {
  test("spawn is non-blocking and children run concurrently", async () => {
    const stub = makeStub();
    const mgr = new SubagentManager({ ...CFG, runFn: stub.runFn });
    const a = mgr.spawn("explorer", "look at A");
    const b = mgr.spawn("explorer", "look at B");
    expect(a).toEqual({ ok: true, id: "t1" });
    expect(b).toEqual({ ok: true, id: "t2" });
    // Both runners started before either finished = parallel.
    expect(stub.calls.length).toBe(2);
    expect(mgr.get("t1")!.status).toBe("running");
    stub.resolvers[0](result({ resultText: "A found" }));
    stub.resolvers[1](result({ resultText: "B found" }));
    const recs = await mgr.wait();
    expect(recs.map((r) => r.status)).toEqual(["done", "done"]);
    expect(recs[0].resultText).toBe("A found");
  });

  test("role presets pin tools, model, and budget", () => {
    const stub = makeStub();
    const mgr = new SubagentManager({ ...CFG, runFn: stub.runFn });
    mgr.spawn("explorer", "x");
    mgr.spawn("reviewer", "y");
    mgr.spawn("implementer", "z");
    const [explorer, reviewer, implementer] = stub.calls;
    expect(explorer.tools.map((t) => t.name)).toEqual(["read", "bash"]);
    expect(explorer.model).toBe("deepseek-v4-flash");
    expect(explorer.maxTurns).toBe(ROLES.explorer.budget.maxTurns);
    expect(reviewer.model).toBe("deepseek-v4-pro");
    expect(implementer.tools.map((t) => t.name)).toEqual(["read", "bash", "edit", "write"]);
    // Role preamble + task + report contract ride in the USER prompt.
    expect(explorer.prompt).toContain("explorer sub-agent");
    expect(explorer.prompt).toContain("Task: x");
    expect(explorer.prompt).toContain("concise report");
  });

  test("unknown role and child cap return errors, not throws", () => {
    const stub = makeStub();
    const mgr = new SubagentManager({ ...CFG, runFn: stub.runFn });
    const bad = mgr.spawn("wizard", "x");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("unknown role");
    for (let i = 0; i < MAX_CHILDREN; i++) expect(mgr.spawn("explorer", "x").ok).toBe(true);
    const over = mgr.spawn("explorer", "one too many");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("limit");
  });

  test("token budget kill -> quiet death, partial report", async () => {
    const stub = makeStub();
    const mgr = new SubagentManager({ ...CFG, runFn: stub.runFn });
    mgr.spawn("explorer", "x");
    const opts = stub.calls[0];
    // Simulate turns until the envelope trips (explorer: 150k tokens).
    for (let i = 0; i < 3; i++) {
      opts.onEvent!({
        type: "turn_end",
        turn: i + 1,
        usage: { inputFresh: 60_000, cacheRead: 0, output: 5_000 },
      });
    }
    const [rec] = await mgr.wait();
    expect(rec.status).toBe("partial");
    expect(rec.killedBy).toBe("tokens");
    expect(renderReport(rec)).toContain("budget: tokens");
    expect(renderReport(rec)).toContain("Partial");
  });

  test("max_turns end -> partial with killedBy turns", async () => {
    const stub = makeStub();
    const mgr = new SubagentManager({ ...CFG, runFn: stub.runFn });
    mgr.spawn("explorer", "x");
    stub.resolvers[0](result({ endReason: "max_turns", resultText: "got halfway" }));
    const [rec] = await mgr.wait();
    expect(rec.status).toBe("partial");
    expect(rec.killedBy).toBe("turns");
  });

  test("cancel and cancelAll abort running children", async () => {
    const stub = makeStub();
    const mgr = new SubagentManager({ ...CFG, runFn: stub.runFn });
    mgr.spawn("explorer", "x");
    mgr.spawn("explorer", "y");
    expect(mgr.cancel("t1")).toBe(true);
    mgr.cancelAll();
    const recs = await mgr.wait();
    expect(recs.every((r) => r.status === "cancelled")).toBe(true);
    expect(mgr.cancel("t1")).toBe(false); // settled — nothing to cancel
  });

  test("failed child keeps error text; usage totals include every child", async () => {
    const stub = makeStub();
    const mgr = new SubagentManager({ ...CFG, runFn: stub.runFn });
    mgr.spawn("explorer", "x");
    mgr.spawn("explorer", "y");
    stub.resolvers[0](
      result({ endReason: "error", errorMessage: "boom", resultText: "" }),
    );
    stub.resolvers[1](result());
    const recs = await mgr.wait();
    expect(recs[0].status).toBe("failed");
    expect(recs[0].resultText).toContain("boom");
    expect(mgr.totalUsage()).toEqual({ inputFresh: 2000, cacheRead: 4000, output: 1000 });
  });

  test("persist hook wires per-child session ids and message sink", async () => {
    const stub = makeStub();
    const appended: string[] = [];
    const mgr = new SubagentManager({
      ...CFG,
      runFn: stub.runFn,
      persist: (childId, model) => ({
        sessionId: `parent.${childId}`,
        onMessage: () => appended.push(childId),
      }),
    });
    mgr.spawn("explorer", "x");
    expect(mgr.get("t1")!.sessionId).toBe("parent.t1");
    stub.calls[0].onMessage!({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(appended).toEqual(["t1"]);
    stub.resolvers[0](result());
    await mgr.wait();
  });
});

describe("task tool", () => {
  function setup() {
    const stub = makeStub();
    const mgr = new SubagentManager({ ...CFG, runFn: stub.runFn });
    const tool = makeTaskTool(mgr);
    return { stub, mgr, tool };
  }
  const ctx = { cwd: "/work" };

  test("spawn -> wait returns rendered reports", async () => {
    const { stub, tool } = setup();
    const s1 = await tool.execute({ action: "spawn", role: "explorer", prompt: "a" }, ctx);
    expect(s1.output).toContain("Spawned t1");
    await tool.execute({ action: "spawn", role: "tester", prompt: "b" }, ctx);
    stub.resolvers[0](result({ resultText: "alpha" }));
    stub.resolvers[1](result({ resultText: "beta" }));
    const w = await tool.execute({ action: "wait" }, ctx);
    expect(w.isError ?? false).toBe(false);
    expect(w.output).toContain("[t1 explorer] done");
    expect(w.output).toContain("alpha");
    expect(w.output).toContain("[t2 tester] done");
    expect(w.output).toContain("beta");
  });

  test("wait with ids selects; result on running/missing/finished", async () => {
    const { stub, tool } = setup();
    await tool.execute({ action: "spawn", role: "explorer", prompt: "a" }, ctx);
    const running = await tool.execute({ action: "result", id: "t1" }, ctx);
    expect(running.isError).toBe(true);
    const missing = await tool.execute({ action: "result", id: "t9" }, ctx);
    expect(missing.isError).toBe(true);
    stub.resolvers[0](result({ resultText: "alpha" }));
    const w = await tool.execute({ action: "wait", ids: ["t1"] }, ctx);
    expect(w.output).toContain("alpha");
    const done = await tool.execute({ action: "result", id: "t1" }, ctx);
    expect(done.isError ?? false).toBe(false);
  });

  test("cancel, bad spawn args, empty wait, unknown action", async () => {
    const { tool } = setup();
    expect((await tool.execute({ action: "wait" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ action: "cancel", id: "t1" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ action: "spawn", role: "explorer" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ action: "spawn", role: "nope", prompt: "x" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ action: "explode" }, ctx)).isError).toBe(true);
    await tool.execute({ action: "spawn", role: "explorer", prompt: "a" }, ctx);
    const c = await tool.execute({ action: "cancel", id: "t1" }, ctx);
    expect(c.output).toContain("Cancelled t1");
  });
});
