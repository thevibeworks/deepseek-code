// Scheduler tests: stub runner, no network, real files in a temp dir.
// What matters: validation uses the firing parser, ledger writes are
// atomic and offset-followable, cron fires once per matching minute,
// once fires once EVER (across daemon restarts), requests are honored
// exactly once, overlap skips, budgets kill into partial reports, and a
// crashed daemon's leftover run_start gets reaped.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOptions, RunResult } from "../src/engine/loop";
import { Scheduler, presetTools } from "../src/scheduler/daemon";
import type { JobSpec, RunEnd, RunEvent } from "../src/scheduler/ledger";
import { foldRuns, JobLedger, newRunsState, validateJobSpec } from "../src/scheduler/ledger";

let dir: string;
let ledger: JobLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsc-sched-"));
  ledger = new JobLedger(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function job(over: Partial<JobSpec> = {}): JobSpec {
  return {
    id: "j1",
    prompt: "do the thing",
    cwd: dir,
    model: "deepseek-v4-flash",
    tools: "read",
    trigger: { kind: "cron", expr: "* * * * *" },
    budget: { maxTurns: 5, maxTotalTokens: 100_000, maxWallMs: 60_000 },
    createdAt: "2026-08-05T00:00:00Z",
    ...over,
  };
}

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    messages: [],
    turns: 2,
    usage: { inputFresh: 100, cacheRead: 200, output: 50 },
    apiMs: 5,
    resultText: "did the thing",
    endReason: "completed",
    compactions: 0,
    ...over,
  };
}

/** Controllable runner: resolves when told, or aborts with the signal. */
function makeStub() {
  const calls: RunOptions[] = [];
  const resolvers: Array<(r: RunResult) => void> = [];
  const runFn = (opts: RunOptions): Promise<RunResult> => {
    calls.push(opts);
    return new Promise((resolve) => {
      resolvers.push(resolve);
      opts.signal?.addEventListener(
        "abort",
        () => resolve(result({ endReason: "aborted", resultText: "partial" })),
        { once: true },
      );
    });
  };
  return { calls, resolvers, runFn };
}

const CFG = (stub: ReturnType<typeof makeStub>, over: Record<string, unknown> = {}) => ({
  ledger,
  apiKey: "k",
  baseUrl: "http://x",
  runFn: stub.runFn,
  persist: (j: JobSpec, runId: string) => ({ sessionId: `${j.id}.${runId}`, onMessage: () => {} }),
  ...over,
});

const at = (mm: number, ss = 0) => new Date(2026, 7, 5, 10, mm, ss);

describe("validateJobSpec", () => {
  test("bad cron is rejected by the same parser that fires", () => {
    const p = validateJobSpec(job({ trigger: { kind: "cron", expr: "61 * * * *" } }));
    expect(p.join(" ")).toMatch(/out of range/);
  });

  test("all problems reported at once", () => {
    const p = validateJobSpec(
      job({ id: "BAD ID", prompt: " ", model: "nope", cwd: "relative/path" }),
    );
    expect(p.length).toBeGreaterThanOrEqual(4);
  });

  test("watch interval floor and once timestamp", () => {
    expect(
      validateJobSpec(job({ trigger: { kind: "watch", command: "true", everySeconds: 1 } })).join(" "),
    ).toMatch(/at least 5/);
    expect(
      validateJobSpec(job({ trigger: { kind: "once", at: "not-a-date" } })).join(" "),
    ).toMatch(/not a parseable/);
  });
});

describe("JobLedger", () => {
  test("add / list / remove round-trip, atomic file", () => {
    expect(ledger.addJob(job())).toEqual({ ok: true });
    expect(ledger.addJob(job()).ok).toBe(false); // duplicate id
    const onDisk = JSON.parse(readFileSync(ledger.jobsPath, "utf8"));
    expect(onDisk.jobs.length).toBe(1);
    expect(ledger.removeJob("j1")).toBe(true);
    expect(ledger.removeJob("j1")).toBe(false);
    expect(ledger.loadJobs()).toEqual([]);
  });

  test("readRuns follows from an offset and skips partial tails", () => {
    ledger.appendRun({ type: "run_request", job: "j1", requestId: "r1", at: "t" });
    const first = ledger.readRuns(0);
    expect(first.events.length).toBe(1);
    // A partial line (no trailing newline) must not be returned yet.
    appendFileSync(ledger.runsPath, '{"type":"run_request","job":"j1","requestId":"r2"');
    const second = ledger.readRuns(first.offset);
    expect(second.events.length).toBe(0);
    appendFileSync(ledger.runsPath, ',"at":"t"}\n');
    const third = ledger.readRuns(second.offset);
    expect(third.events.length).toBe(1);
    expect((third.events[0] as { requestId: string }).requestId).toBe("r2");
  });

  test("corrupt lines are skipped, not fatal", () => {
    appendFileSync(ledger.runsPath, "not json\n");
    ledger.appendRun({ type: "run_request", job: "j1", requestId: "r1", at: "t" });
    expect(ledger.readRuns(0).events.length).toBe(1);
  });
});

describe("Scheduler", () => {
  test("cron fires once per matching minute, again the next minute", async () => {
    ledger.addJob(job());
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    await s.tick(at(0, 5));
    await s.tick(at(0, 35)); // same minute — no second fire
    expect(stub.calls.length).toBe(1);
    stub.resolvers[0](result());
    await new Promise((r) => setTimeout(r, 5)); // let finishRun settle
    await s.tick(at(1, 5)); // next minute — fires again
    expect(stub.calls.length).toBe(2);
    stub.resolvers[1](result());
    await new Promise((r) => setTimeout(r, 5));
  });

  test("run_start hits the ledger before the run resolves (ps mid-run)", async () => {
    ledger.addJob(job());
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    await s.tick(at(0));
    const { events } = ledger.readRuns(0);
    const start = events.find((e) => e.type === "run_start");
    expect(start).toBeDefined();
    expect((start as { sessionId: string }).sessionId).toContain("j1.");
    stub.resolvers[0](result());
  });

  test("overlap: a due cron while still running is skipped", async () => {
    ledger.addJob(job());
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    await s.tick(at(0));
    await s.tick(at(1)); // previous run still pending
    expect(stub.calls.length).toBe(1);
    stub.resolvers[0](result());
    await new Promise((r) => setTimeout(r, 5)); // let finishRun settle
    await s.tick(at(2));
    expect(stub.calls.length).toBe(2);
    stub.resolvers[1](result());
    await new Promise((r) => setTimeout(r, 5));
  });

  test("once fires once ever, surviving a daemon restart", async () => {
    ledger.addJob(job({ trigger: { kind: "once", at: at(0).toISOString() } }));
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    await s.tick(at(5));
    expect(stub.calls.length).toBe(1);
    stub.resolvers[0](result());
    await Promise.resolve();
    await s.tick(at(6));
    expect(stub.calls.length).toBe(1);
    // Restart: a fresh Scheduler folds the ledger and still refuses.
    const s2 = new Scheduler(CFG(stub));
    await s2.tick(at(7));
    expect(stub.calls.length).toBe(1);
  });

  test("run_request fires immediately and is honored exactly once", async () => {
    ledger.addJob(job({ trigger: { kind: "once", at: "2099-01-01T00:00:00Z" } }));
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    ledger.appendRun({ type: "run_request", job: "j1", requestId: "req-1", at: "t" });
    await s.tick(at(0));
    expect(stub.calls.length).toBe(1);
    stub.resolvers[0](result());
    await Promise.resolve();
    await s.tick(at(1));
    expect(stub.calls.length).toBe(1); // not honored twice
    const starts = ledger.readRuns(0).events.filter((e) => e.type === "run_start");
    expect((starts[0] as { requestId?: string }).requestId).toBe("req-1");
  });

  test("request for a deleted job is dropped", async () => {
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    ledger.appendRun({ type: "run_request", job: "ghost", requestId: "req-9", at: "t" });
    await s.tick(at(0));
    expect(stub.calls.length).toBe(0);
  });

  test("wall budget kills into a partial run_end", async () => {
    ledger.addJob(job({ budget: { maxTurns: 5, maxTotalTokens: 100_000, maxWallMs: 30 } }));
    const stub = makeStub(); // never resolves until aborted
    const s = new Scheduler(CFG(stub));
    await s.tick(at(0));
    await new Promise((r) => setTimeout(r, 80));
    const ends = ledger.readRuns(0).events.filter((e): e is RunEnd => e.type === "run_end");
    expect(ends.length).toBe(1);
    expect(ends[0].status).toBe("partial");
    expect(ends[0].killedBy).toBe("wall");
  });

  test("token budget kills via turn_end usage", async () => {
    ledger.addJob(job({ budget: { maxTurns: 5, maxTotalTokens: 1_000, maxWallMs: 60_000 } }));
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    await s.tick(at(0));
    const opts = stub.calls[0];
    opts.onEvent?.({
      type: "turn_end",
      turn: 1,
      usage: { inputFresh: 900, cacheRead: 200, output: 100 },
    });
    await new Promise((r) => setTimeout(r, 10));
    const ends = ledger.readRuns(0).events.filter((e): e is RunEnd => e.type === "run_end");
    expect(ends.length).toBe(1);
    expect(ends[0].status).toBe("partial");
    expect(ends[0].killedBy).toBe("tokens");
  });

  test("watch: predicate true fires, interval gates re-checks", async () => {
    ledger.addJob(job({ trigger: { kind: "watch", command: "true", everySeconds: 60 } }));
    const stub = makeStub();
    let checks = 0;
    const s = new Scheduler(
      CFG(stub, {
        predicateFn: async () => {
          checks++;
          return checks === 2; // fire on the second check only
        },
      }),
    );
    await s.tick(at(0));
    await new Promise((r) => setTimeout(r, 5));
    expect(checks).toBe(1);
    expect(stub.calls.length).toBe(0);
    await s.tick(at(0, 30)); // inside the interval — no re-check
    expect(checks).toBe(1);
    await s.tick(at(1, 10)); // past the interval — checks and fires
    await new Promise((r) => setTimeout(r, 5));
    expect(checks).toBe(2);
    expect(stub.calls.length).toBe(1);
    stub.resolvers[0](result());
  });

  test("stale run_start from a dead pid is reaped at startup", async () => {
    ledger.addJob(job());
    ledger.appendRun({
      type: "run_start",
      job: "j1",
      runId: "j1-stale",
      sessionId: "j1.stale",
      pid: 999_999_9,
      at: "t",
    });
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    const ends = ledger.readRuns(0).events.filter((e): e is RunEnd => e.type === "run_end");
    expect(ends.length).toBe(1);
    expect(ends[0].status).toBe("cancelled");
    expect(ends[0].runId).toBe("j1-stale");
    // And the job is free to fire again.
    await s.tick(at(0));
    expect(stub.calls.length).toBe(1);
    stub.resolvers[0](result());
  });

  test("notify hook receives the end record", async () => {
    ledger.addJob(job({ notify: "true" }));
    const stub = makeStub();
    const seen: RunEnd[] = [];
    const s = new Scheduler(CFG(stub, { notifyFn: async (_j: JobSpec, e: RunEnd) => void seen.push(e) }));
    await s.tick(at(0));
    stub.resolvers[0](result());
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.length).toBe(1);
    expect(seen[0].status).toBe("done");
    expect(seen[0].result).toBe("did the thing");
  });

  test("shutdown aborts live runs into cancelled run_ends", async () => {
    ledger.addJob(job());
    const stub = makeStub();
    const s = new Scheduler(CFG(stub));
    await s.tick(at(0));
    expect(s.liveCount()).toBe(1);
    await s.shutdown();
    const ends = ledger.readRuns(0).events.filter((e): e is RunEnd => e.type === "run_end");
    expect(ends.length).toBe(1);
    expect(ends[0].status).toBe("cancelled");
  });
});

describe("presetTools", () => {
  test("read preset carries the classified bash, write the full set", () => {
    const read = presetTools("read").map((t) => t.name);
    const write = presetTools("write").map((t) => t.name);
    expect(read).toEqual(["read", "bash"]);
    expect(write).toEqual(["read", "bash", "edit", "write"]);
  });
});

describe("foldRuns", () => {
  test("start/end pairing and request honoring", () => {
    const state = newRunsState();
    const events: RunEvent[] = [
      { type: "run_request", job: "a", requestId: "r1", at: "t" },
      { type: "run_start", job: "a", runId: "a-1", sessionId: "s", requestId: "r1", pid: 1, at: "t" },
      {
        type: "run_end",
        job: "a",
        runId: "a-1",
        sessionId: "s",
        status: "done",
        endReason: "completed",
        turns: 1,
        usage: { inputFresh: 1, cacheRead: 2, output: 3 },
        wallMs: 10,
        result: "ok",
        at: "t",
      },
    ];
    foldRuns(state, events);
    expect(state.running.size).toBe(0);
    expect(state.honored.has("r1")).toBe(true);
    expect(state.everStarted.has("a")).toBe(true);
    expect(state.lastEnd.get("a")?.status).toBe("done");
  });
});
