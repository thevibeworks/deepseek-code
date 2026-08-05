// The scheduler's two files (DESIGN.md pillar 1, goose trap list from
// Round 3 delta #6):
//
//   jobs.json      — definitions. CLI verbs edit THIS and only this;
//                    every write is tmp+rename so a crashed add can
//                    never leave a half-written ledger.
//   job-runs.jsonl — append-only events (run_request / run_start /
//                    run_end). The serve daemon appends state
//                    transitions the moment they happen, so `dsc ps` in
//                    another process sees a running job's session id
//                    mid-run. Requests appended by the CLI are how
//                    "run now" reaches the daemon without the CLI ever
//                    firing a job itself.
//
// Jobs fire ONLY in the long-lived `dsc serve` process. Nothing here
// runs anything.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MODELS } from "../provider/catalog";
import { parseCron } from "./cron";

export type ToolPreset = "read" | "write";

export type Trigger =
  | { kind: "cron"; expr: string }
  | { kind: "watch"; command: string; everySeconds: number }
  | { kind: "once"; at: string };

export type JobBudget = { maxTurns: number; maxTotalTokens: number; maxWallMs: number };

/** Default envelope for a scheduled run: the implementer sub-agent's
 * budget with more wall clock (cron work is not interactive). */
export const DEFAULT_JOB_BUDGET: JobBudget = {
  maxTurns: 24,
  maxTotalTokens: 300_000,
  maxWallMs: 300_000,
};

export type JobSpec = {
  id: string;
  prompt: string;
  cwd: string;
  model: string;
  tools: ToolPreset;
  trigger: Trigger;
  budget: JobBudget;
  /** Command run when a firing ends; gets DSC_JOB/DSC_STATUS/DSC_SESSION
   * in env and the result text on stdin. */
  notify?: string;
  createdAt: string;
};

export type RunStart = {
  type: "run_start";
  job: string;
  runId: string;
  sessionId: string;
  /** Present when this firing honors a `dsc job run` request. */
  requestId?: string;
  pid: number;
  at: string;
};

export type RunEnd = {
  type: "run_end";
  job: string;
  runId: string;
  /** Session holding the full transcript (empty when not persisted). */
  sessionId: string;
  status: "done" | "partial" | "failed" | "cancelled";
  endReason: string;
  killedBy?: "turns" | "tokens" | "wall";
  turns: number;
  /** Full miss/hit/output split — cache reads are 50x cheaper than
   * misses, so a single input total cannot be re-priced later. */
  usage: { inputFresh: number; cacheRead: number; output: number };
  wallMs: number;
  /** Final text, clipped — the full transcript lives in the session. */
  result: string;
  at: string;
};

export type RunRequest = { type: "run_request"; job: string; requestId: string; at: string };

export type RunEvent = RunStart | RunEnd | RunRequest;

export function defaultDataDir(): string {
  return process.env.DSC_DATA_DIR ?? join(homedir(), ".dsc");
}

/** Validate a job spec with the SAME code paths that fire it: parseCron
 * for cron, Date parsing for once. Returns every problem at once. */
export function validateJobSpec(spec: JobSpec): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(spec.id)) {
    problems.push(`id "${spec.id}" must be lowercase alphanumeric/dashes (max 64 chars)`);
  }
  if (spec.prompt.trim() === "") problems.push("prompt must not be empty");
  if (!isAbsolute(spec.cwd)) problems.push(`cwd "${spec.cwd}" must be absolute`);
  else if (!existsSync(spec.cwd)) problems.push(`cwd "${spec.cwd}" does not exist`);
  if (MODELS[spec.model] === undefined) {
    problems.push(`unknown model "${spec.model}" (known: ${Object.keys(MODELS).join(", ")})`);
  }
  if (spec.tools !== "read" && spec.tools !== "write") {
    problems.push(`tools must be "read" or "write", got "${spec.tools}"`);
  }
  const t = spec.trigger;
  if (t.kind === "cron") {
    try {
      parseCron(t.expr);
    } catch (err) {
      problems.push(String(err instanceof Error ? err.message : err));
    }
  } else if (t.kind === "watch") {
    if (t.command.trim() === "") problems.push("watch command must not be empty");
    if (!Number.isFinite(t.everySeconds) || t.everySeconds < 5) {
      problems.push("watch interval must be at least 5 seconds");
    }
  } else if (t.kind === "once") {
    if (Number.isNaN(Date.parse(t.at))) problems.push(`"${t.at}" is not a parseable timestamp`);
  } else {
    problems.push("trigger must be cron, watch, or once");
  }
  for (const [k, v] of Object.entries(spec.budget)) {
    if (!Number.isFinite(v) || v <= 0) problems.push(`budget ${k} must be a positive number`);
  }
  return problems;
}

export class JobLedger {
  readonly jobsPath: string;
  readonly runsPath: string;

  constructor(readonly dir: string = defaultDataDir()) {
    this.jobsPath = join(dir, "jobs.json");
    this.runsPath = join(dir, "job-runs.jsonl");
  }

  loadJobs(): JobSpec[] {
    if (!existsSync(this.jobsPath)) return [];
    const doc = JSON.parse(readFileSync(this.jobsPath, "utf8"));
    return Array.isArray(doc.jobs) ? (doc.jobs as JobSpec[]) : [];
  }

  /** Atomic tmp+rename — the goose trap. A reader (the daemon re-reads
   * every tick) sees either the old ledger or the new one, never a
   * torn write. */
  private writeJobs(jobs: JobSpec[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.jobsPath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, jobs }, null, 2) + "\n");
    renameSync(tmp, this.jobsPath);
  }

  /** Validates before writing; rejects duplicate ids. */
  addJob(spec: JobSpec): { ok: true } | { ok: false; problems: string[] } {
    const problems = validateJobSpec(spec);
    if (problems.length > 0) return { ok: false, problems };
    const jobs = this.loadJobs();
    if (jobs.some((j) => j.id === spec.id)) {
      return { ok: false, problems: [`a job with id "${spec.id}" already exists`] };
    }
    jobs.push(spec);
    this.writeJobs(jobs);
    return { ok: true };
  }

  removeJob(id: string): boolean {
    const jobs = this.loadJobs();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length) return false;
    this.writeJobs(next);
    return true;
  }

  appendRun(event: RunEvent): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.runsPath, JSON.stringify(event) + "\n");
  }

  /** Read run events from a byte offset (the daemon tail-follows its own
   * file to pick up CLI-appended requests without re-reading history).
   * Unparseable lines are skipped, not fatal — one corrupt line must not
   * take the scheduler down. */
  readRuns(fromOffset = 0): { events: RunEvent[]; offset: number } {
    if (!existsSync(this.runsPath)) return { events: [], offset: 0 };
    const size = statSync(this.runsPath).size;
    if (fromOffset >= size) return { events: [], offset: size };
    const buf = readFileSync(this.runsPath);
    const text = buf.subarray(fromOffset).toString("utf8");
    // Only complete lines: a concurrent append may leave a partial tail.
    const end = text.lastIndexOf("\n");
    if (end < 0) return { events: [], offset: fromOffset };
    const events: RunEvent[] = [];
    for (const line of text.slice(0, end).split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as RunEvent);
      } catch {
        // skip corrupt line
      }
    }
    return { events, offset: fromOffset + Buffer.byteLength(text.slice(0, end + 1), "utf8") };
  }
}

/** Fold run events into the state the daemon and `dsc ps` need. */
export type RunsState = {
  /** run_start without a matching run_end, keyed by job id. */
  running: Map<string, RunStart>;
  /** Latest run_end per job. */
  lastEnd: Map<string, RunEnd>;
  /** Request ids already honored by a run_start. */
  honored: Set<string>;
  /** Requests seen (id -> event), in order. */
  requests: Map<string, RunRequest>;
  /** Jobs that have ever started a run (drives once-trigger dedup). */
  everStarted: Set<string>;
};

export function newRunsState(): RunsState {
  return {
    running: new Map(),
    lastEnd: new Map(),
    honored: new Set(),
    requests: new Map(),
    everStarted: new Set(),
  };
}

export function foldRuns(state: RunsState, events: RunEvent[]): RunsState {
  for (const e of events) {
    if (e.type === "run_start") {
      state.running.set(e.job, e);
      state.everStarted.add(e.job);
      if (e.requestId !== undefined) state.honored.add(e.requestId);
    } else if (e.type === "run_end") {
      const r = state.running.get(e.job);
      if (r !== undefined && r.runId === e.runId) state.running.delete(e.job);
      state.lastEnd.set(e.job, e);
    } else {
      state.requests.set(e.requestId, e);
    }
  }
  return state;
}
