// The scheduler daemon — the ONLY process that fires jobs (Round 3
// delta #6). CLI verbs edit jobs.json and append run requests; this
// loop reads both every tick and runs what is due, each firing a
// headless session under a hard budget envelope (the sub-agent budget
// mechanics, standalone: wall timer + token watch + turn cap).
//
// Firing is match-based: a cron job fires when the current minute
// matches and it has not already fired in that minute. A daemon that was
// down does not backfill missed boundaries — a sync job that runs at the
// next boundary is current; six catch-up runs are noise.
//
// Overlap policy: a job still running when its next trigger comes due is
// skipped (logged), not queued. Cron work is idempotent-by-design or it
// should not be scheduled.

import type { RunOptions, RunResult } from "../engine/loop";
import { runLoop } from "../engine/loop";
import type { Message, Usage } from "../provider/types";
import { MODELS } from "../provider/catalog";
import type { ToolDefinition } from "../tools/index";
import { readTool } from "../tools/read";
import { bashTool, readOnlyBashTool } from "../tools/bash";
import { editTool } from "../tools/edit";
import { writeTool } from "../tools/write";
import { cronMatches, parseCron } from "./cron";
import type { JobSpec, RunEnd, RunStart, RunsState } from "./ledger";
import { foldRuns, JobLedger, newRunsState } from "./ledger";

const RESULT_CLIP = 2_000;
const PREDICATE_TIMEOUT_MS = 30_000;
const NOTIFY_TIMEOUT_MS = 30_000;

export function presetTools(preset: JobSpec["tools"]): ToolDefinition[] {
  return preset === "read"
    ? [readTool, readOnlyBashTool]
    : [readTool, bashTool, editTool, writeTool];
}

export type SchedulerConfig = {
  ledger: JobLedger;
  apiKey: string;
  baseUrl: string;
  /** Injectable loop runner (tests stub this). */
  runFn?: (opts: RunOptions) => Promise<RunResult>;
  /** Injectable watch predicate: true = fire. Default runs the command
   * in the job's cwd with a hard timeout; exit 0 fires. */
  predicateFn?: (command: string, cwd: string) => Promise<boolean>;
  /** Injectable notification hook. Default spawns job.notify with
   * DSC_JOB/DSC_STATUS/DSC_SESSION/DSC_RUN_ID env and result on stdin. */
  notifyFn?: (job: JobSpec, end: RunEnd) => Promise<void>;
  /** Session persistence for a firing. Default is no persistence (tests);
   * `dsc serve` wires the SQLite store here. */
  persist?: (job: JobSpec, runId: string) => { sessionId: string; onMessage: (m: Message) => void };
  log?: (line: string) => void;
};

type LiveRun = { promise: Promise<void>; controller: AbortController };

export class Scheduler {
  private readonly state: RunsState = newRunsState();
  private runsOffset = 0;
  private readonly live = new Map<string, LiveRun>();
  private readonly lastCronMinute = new Map<string, number>();
  private readonly lastWatchCheck = new Map<string, number>();
  private readonly checking = new Set<string>();
  private runCounter = 0;
  private readonly log: (line: string) => void;

  constructor(private readonly cfg: SchedulerConfig) {
    this.log = cfg.log ?? (() => {});
    const { events, offset } = cfg.ledger.readRuns(0);
    foldRuns(this.state, events);
    this.runsOffset = offset;
    this.reapStaleRuns();
  }

  /** A run_start without run_end whose pid is dead is a crashed daemon's
   * leftover. Close it in the ledger or it blocks its job forever. */
  private reapStaleRuns(): void {
    for (const [job, start] of [...this.state.running]) {
      if (pidAlive(start.pid)) continue;
      const end: RunEnd = {
        type: "run_end",
        job,
        runId: start.runId,
        sessionId: start.sessionId,
        status: "cancelled",
        endReason: "daemon exited before the run finished",
        turns: 0,
        usage: { inputFresh: 0, cacheRead: 0, output: 0 },
        wallMs: 0,
        result: "",
        at: new Date().toISOString(),
      };
      this.cfg.ledger.appendRun(end);
      this.state.running.delete(job);
      this.state.lastEnd.set(job, end);
      this.log(`reaped stale run ${start.runId} (job ${job}, pid ${start.pid} dead)`);
    }
  }

  /** One scheduling pass. Reloads jobs.json (CLI edits are picked up
   * without a restart) and tail-follows the runs file for requests. */
  async tick(now: Date): Promise<void> {
    const { events, offset } = this.cfg.ledger.readRuns(this.runsOffset);
    foldRuns(this.state, events);
    this.runsOffset = offset;

    const jobs = this.cfg.ledger.loadJobs();
    const byId = new Map(jobs.map((j) => [j.id, j]));

    // Run-now requests first: an explicit ask beats a timer.
    for (const [requestId, req] of this.state.requests) {
      if (this.state.honored.has(requestId)) continue;
      const job = byId.get(req.job);
      if (job === undefined) {
        this.state.honored.add(requestId); // job deleted; drop the request
        continue;
      }
      if (this.jobBusy(job.id)) continue; // retry next tick
      this.fire(job, now, requestId);
    }

    for (const job of jobs) {
      if (this.jobBusy(job.id)) continue;
      const t = job.trigger;
      if (t.kind === "cron") {
        const minute = Math.floor(now.getTime() / 60_000);
        if (this.lastCronMinute.get(job.id) === minute) continue;
        // add-time validation runs the same parser, but jobs.json can be
        // hand-edited; a bad expression skips one job, never kills a tick.
        let due: boolean;
        try {
          due = cronMatches(parseCron(t.expr), now);
        } catch (err) {
          this.log(`bad cron for job ${job.id}: ${String(err)}`);
          continue;
        }
        if (!due) continue;
        this.lastCronMinute.set(job.id, minute);
        this.fire(job, now);
      } else if (t.kind === "once") {
        if (this.state.everStarted.has(job.id)) continue;
        if (now.getTime() < Date.parse(t.at)) continue;
        this.fire(job, now);
      } else {
        const last = this.lastWatchCheck.get(job.id) ?? 0;
        if (now.getTime() - last < t.everySeconds * 1_000) continue;
        if (this.checking.has(job.id)) continue;
        this.lastWatchCheck.set(job.id, now.getTime());
        this.checking.add(job.id);
        const predicate = this.cfg.predicateFn ?? defaultPredicate;
        void predicate(t.command, job.cwd)
          .then((due) => {
            // Re-check busy: the predicate ran concurrently with the tick.
            if (due && !this.jobBusy(job.id)) this.fire(job, new Date(now.getTime()));
          })
          .catch((err) => this.log(`watch predicate failed (job ${job.id}): ${String(err)}`))
          .finally(() => this.checking.delete(job.id));
      }
    }
  }

  private jobBusy(id: string): boolean {
    return this.live.has(id) || this.state.running.has(id);
  }

  private fire(job: JobSpec, now: Date, requestId?: string): void {
    this.runCounter++;
    const runId = `${job.id}-${now.getTime().toString(36)}-${this.runCounter}`;
    const persisted = this.cfg.persist?.(job, runId);
    const start: RunStart = {
      type: "run_start",
      job: job.id,
      runId,
      sessionId: persisted?.sessionId ?? "",
      ...(requestId !== undefined ? { requestId } : {}),
      pid: process.pid,
      at: now.toISOString(),
    };
    // Ledger first, then memory: run_start is on disk before the run can
    // produce any observable effect, so `dsc ps` mid-run sees it.
    this.cfg.ledger.appendRun(start);
    this.state.running.set(job.id, start);
    this.state.everStarted.add(job.id);
    if (requestId !== undefined) this.state.honored.add(requestId);
    this.log(`fire ${runId} (job ${job.id}${requestId !== undefined ? ", run-now" : ""})`);

    const controller = new AbortController();
    let budgetHit: "tokens" | "wall" | undefined;
    const wallTimer = setTimeout(() => {
      budgetHit = "wall";
      controller.abort();
    }, job.budget.maxWallMs);
    let spent = 0;
    const runFn = this.cfg.runFn ?? runLoop;
    const t0 = now.getTime();

    const sessionId = start.sessionId;
    const promise = runFn({
      prompt: job.prompt,
      model: job.model,
      cwd: job.cwd,
      apiKey: this.cfg.apiKey,
      baseUrl: this.cfg.baseUrl,
      tools: presetTools(job.tools),
      maxTurns: job.budget.maxTurns,
      signal: controller.signal,
      contextBudget: MODELS[job.model]?.inputBudget ?? 616_000,
      ...(persisted !== undefined ? { onMessage: persisted.onMessage } : {}),
      onEvent: (e) => {
        if (e.type !== "turn_end") return;
        spent += e.usage.inputFresh + e.usage.cacheRead + e.usage.output;
        if (spent > job.budget.maxTotalTokens && budgetHit === undefined) {
          budgetHit = "tokens";
          controller.abort();
        }
      },
    })
      .then((result) => this.finishRun(job, runId, sessionId, result, budgetHit, Date.now() - t0))
      .catch((err) =>
        this.finishRun(
          job,
          runId,
          sessionId,
          {
            messages: [],
            turns: 0,
            usage: { inputFresh: 0, cacheRead: 0, output: 0 },
            apiMs: 0,
            resultText: `(run crashed: ${String(err)})`,
            endReason: "error",
            errorMessage: String(err),
            compactions: 0,
          },
          budgetHit,
          Date.now() - t0,
        ),
      )
      .finally(() => {
        clearTimeout(wallTimer);
        this.live.delete(job.id);
      });
    this.live.set(job.id, { promise, controller });
  }

  private async finishRun(
    job: JobSpec,
    runId: string,
    sessionId: string,
    result: RunResult,
    budgetHit: "tokens" | "wall" | undefined,
    wallMs: number,
  ): Promise<void> {
    const status: RunEnd["status"] =
      result.endReason === "completed"
        ? "done"
        : result.endReason === "max_turns"
          ? "partial"
          : result.endReason === "aborted"
            ? budgetHit !== undefined
              ? "partial"
              : "cancelled"
            : "failed";
    const end: RunEnd = {
      type: "run_end",
      job: job.id,
      runId,
      sessionId,
      status,
      endReason: result.errorMessage !== undefined ? `${result.endReason}: ${result.errorMessage}` : result.endReason,
      ...(result.endReason === "max_turns"
        ? { killedBy: "turns" as const }
        : budgetHit !== undefined
          ? { killedBy: budgetHit }
          : {}),
      turns: result.turns,
      usage: result.usage,
      wallMs,
      result: clip(result.resultText, RESULT_CLIP),
      at: new Date().toISOString(),
    };
    this.cfg.ledger.appendRun(end);
    this.state.running.delete(job.id);
    this.state.lastEnd.set(job.id, end);
    this.log(`end ${runId}: ${status} (${result.turns} turns, ${Math.round(wallMs / 1000)}s)`);
    if (job.notify !== undefined) {
      const notify = this.cfg.notifyFn ?? defaultNotify;
      try {
        await notify(job, end);
      } catch (err) {
        this.log(`notify failed (job ${job.id}): ${String(err)}`);
      }
    }
  }

  /** Abort every live run and wait for their run_end events to land. */
  async shutdown(): Promise<void> {
    for (const { controller } of this.live.values()) controller.abort();
    await Promise.allSettled([...this.live.values()].map((l) => l.promise));
  }

  /** Live runs owned by THIS process (for tests and ps). */
  liveCount(): number {
    return this.live.size;
  }
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + " …";
}

/** Same-host pid liveness (also used by ps and the serve lockfile). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultPredicate(command: string, cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(9), PREDICATE_TIMEOUT_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  return code === 0;
}

async function defaultNotify(job: JobSpec, end: RunEnd): Promise<void> {
  const proc = Bun.spawn(["bash", "-c", job.notify ?? "true"], {
    cwd: job.cwd,
    env: {
      ...(process.env as Record<string, string>),
      DSC_JOB: job.id,
      DSC_STATUS: end.status,
      DSC_RUN_ID: end.runId,
      DSC_SESSION: end.sessionId,
    },
    stdin: new Response(end.result).body ?? "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(9), NOTIFY_TIMEOUT_MS);
  await proc.exited;
  clearTimeout(timer);
}

/** Compute the summed usage of a set of run ends (ps totals). */
export function sumUsage(ends: Iterable<RunEnd>): Usage {
  const u: Usage = { inputFresh: 0, cacheRead: 0, output: 0 };
  for (const e of ends) {
    u.inputFresh += e.usage.inputFresh;
    u.cacheRead += e.usage.cacheRead;
    u.output += e.usage.output;
  }
  return u;
}
