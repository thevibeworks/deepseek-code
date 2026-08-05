// Scheduler CLI verbs. The contract (Round 3 delta #6): these verbs edit
// the ledger and read it — they NEVER fire a job. `dsc job run` appends a
// request that the serve daemon honors; if no daemon is alive it says so
// instead of silently queueing into the void.
//
//   dsc job add <id> --prompt P (--cron E | --watch CMD --every N | --at TS)
//                    [--cwd DIR] [--model M] [--tools read|write]
//                    [--max-turns N] [--max-tokens N] [--max-wall SECONDS]
//                    [--notify CMD]
//   dsc job list | dsc job rm <id> | dsc job run <id>
//   dsc ps
//   dsc serve [--interval SECONDS]

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "../provider/catalog";
import { resolveApiKey } from "../config";
import { SessionStore } from "../session/store";
import { pidAlive, Scheduler } from "./daemon";
import { cronNext, parseCron } from "./cron";
import type { JobSpec, Trigger } from "./ledger";
import { DEFAULT_JOB_BUDGET, defaultDataDir, foldRuns, JobLedger, newRunsState } from "./ledger";

const USAGE = `usage:
  dsc job add <id> --prompt P (--cron "E" | --watch CMD --every N | --at TS)
        [--cwd DIR] [--model M] [--tools read|write] [--notify CMD]
        [--max-turns N] [--max-tokens N] [--max-wall SECONDS]
  dsc job list             jobs with next fire and last result
  dsc job rm <id>          remove a job
  dsc job run <id>         ask the serve daemon to fire it now
  dsc ps                   running and scheduled jobs
  dsc serve [--interval N] the scheduler daemon (the only firing process)`;

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function schedulerCli(argv: string[]): Promise<number> {
  const ledger = new JobLedger(defaultDataDir());
  const verb = argv[0];
  if (verb === "ps") return ps(ledger);
  if (verb === "serve") return serve(ledger, argv.slice(1));
  if (verb === "job") {
    const sub = argv[1];
    if (sub === "add") return jobAdd(ledger, argv.slice(2));
    if (sub === "list") return jobList(ledger);
    if (sub === "rm") return jobRm(ledger, argv[2]);
    if (sub === "run") return jobRun(ledger, argv[2]);
  }
  console.error(USAGE);
  return 2;
}

function jobAdd(ledger: JobLedger, argv: string[]): number {
  const id = argv[0];
  if (id === undefined || id.startsWith("--")) {
    console.error("dsc job add: the first argument is the job id\n" + USAGE);
    return 2;
  }
  const prompt = argValue(argv, "prompt");
  if (prompt === undefined) {
    console.error("dsc job add: --prompt is required");
    return 2;
  }
  const cron = argValue(argv, "cron");
  const watch = argValue(argv, "watch");
  const atTs = argValue(argv, "at");
  const chosen = [cron, watch, atTs].filter((v) => v !== undefined).length;
  if (chosen !== 1) {
    console.error("dsc job add: exactly one of --cron, --watch, --at");
    return 2;
  }
  let trigger: Trigger;
  if (cron !== undefined) trigger = { kind: "cron", expr: cron };
  else if (watch !== undefined) {
    trigger = { kind: "watch", command: watch, everySeconds: Number(argValue(argv, "every") ?? 60) };
  } else {
    trigger = { kind: "once", at: atTs as string };
  }
  const spec: JobSpec = {
    id,
    prompt,
    cwd: resolve(argValue(argv, "cwd") ?? process.cwd()),
    model: argValue(argv, "model") ?? process.env.DSC_MODEL ?? DEFAULT_MODEL,
    tools: (argValue(argv, "tools") ?? "read") as JobSpec["tools"],
    trigger,
    budget: {
      maxTurns: Number(argValue(argv, "max-turns") ?? DEFAULT_JOB_BUDGET.maxTurns),
      maxTotalTokens: Number(argValue(argv, "max-tokens") ?? DEFAULT_JOB_BUDGET.maxTotalTokens),
      maxWallMs: Number(argValue(argv, "max-wall") ?? DEFAULT_JOB_BUDGET.maxWallMs / 1000) * 1000,
    },
    ...(argValue(argv, "notify") !== undefined ? { notify: argValue(argv, "notify") } : {}),
    createdAt: new Date().toISOString(),
  };
  const r = ledger.addJob(spec);
  if (!r.ok) {
    for (const p of r.problems) console.error(`dsc job add: ${p}`);
    return 2;
  }
  console.log(`added ${id}: ${describeTrigger(spec.trigger)} (${spec.tools} tools, ${spec.model})`);
  if (spec.trigger.kind === "cron") {
    const n = cronNext(parseCron(spec.trigger.expr), new Date());
    if (n !== null) console.log(`next fire: ${fmtTime(n.toISOString())} (when dsc serve is running)`);
  }
  return 0;
}

function jobList(ledger: JobLedger): number {
  const jobs = ledger.loadJobs();
  if (jobs.length === 0) {
    console.log("no jobs (dsc job add --help-style usage: dsc job)");
    return 0;
  }
  const state = foldRuns(newRunsState(), ledger.readRuns(0).events);
  for (const j of jobs) {
    console.log(`${j.id}  ${describeTrigger(j.trigger)}  ${j.tools}  ${j.model}`);
    console.log(`    cwd ${j.cwd}`);
    if (j.trigger.kind === "cron") {
      const n = cronNext(parseCron(j.trigger.expr), new Date());
      if (n !== null) console.log(`    next ${fmtTime(n.toISOString())}`);
    }
    const last = state.lastEnd.get(j.id);
    if (last !== undefined) {
      console.log(`    last ${last.status} at ${fmtTime(last.at)} (${last.turns} turns, ${Math.round(last.wallMs / 1000)}s)${last.sessionId !== "" ? `  session ${last.sessionId}` : ""}`);
    }
  }
  return 0;
}

function jobRm(ledger: JobLedger, id: string | undefined): number {
  if (id === undefined) {
    console.error("dsc job rm: which id? (dsc job list)");
    return 2;
  }
  if (!ledger.removeJob(id)) {
    console.error(`dsc job rm: no job "${id}"`);
    return 2;
  }
  console.log(`removed ${id}`);
  return 0;
}

function jobRun(ledger: JobLedger, id: string | undefined): number {
  if (id === undefined) {
    console.error("dsc job run: which id? (dsc job list)");
    return 2;
  }
  const job = ledger.loadJobs().find((j) => j.id === id);
  if (job === undefined) {
    console.error(`dsc job run: no job "${id}"`);
    return 2;
  }
  const requestId = `req-${Date.now().toString(36)}-${process.pid}`;
  ledger.appendRun({ type: "run_request", job: id, requestId, at: new Date().toISOString() });
  console.log(`requested ${id} (${requestId})`);
  if (!serveAlive(ledger.dir)) {
    console.error("note: no serve daemon is running — the request fires when one starts (dsc serve)");
  }
  return 0;
}

function ps(ledger: JobLedger): number {
  const jobs = ledger.loadJobs();
  const state = foldRuns(newRunsState(), ledger.readRuns(0).events);
  const running = [...state.running.values()];
  if (running.length > 0) {
    console.log("RUNNING");
    for (const r of running) {
      const stale = pidAlive(r.pid) ? "" : "  [stale: daemon dead]";
      console.log(`  ${r.job}  run ${r.runId}  since ${fmtTime(r.at)}${r.sessionId !== "" ? `  session ${r.sessionId}` : ""}${stale}`);
    }
  } else {
    console.log(`RUNNING\n  (none)${serveAlive(ledger.dir) ? "" : "  — no serve daemon"}`);
  }
  console.log("\nJOBS");
  if (jobs.length === 0) console.log("  (none)");
  for (const j of jobs) {
    let next = "";
    if (j.trigger.kind === "cron") {
      const n = cronNext(parseCron(j.trigger.expr), new Date());
      next = n !== null ? `  next ${fmtTime(n.toISOString())}` : "  next: never";
    } else if (j.trigger.kind === "once") {
      next = state.everStarted.has(j.id) ? "  fired" : `  at ${fmtTime(j.trigger.at)}`;
    }
    const last = state.lastEnd.get(j.id);
    const lastStr = last !== undefined ? `  last ${last.status} ${fmtTime(last.at)}` : "";
    console.log(`  ${j.id}  ${describeTrigger(j.trigger)}${next}${lastStr}`);
  }
  return 0;
}

async function serve(ledger: JobLedger, argv: string[]): Promise<number> {
  const apiKey = resolveApiKey();
  if (apiKey === null) {
    console.error("dsc serve: no API key ($DEEPSEEK_API_KEY or ~/.dsc/key)");
    return 2;
  }
  const intervalMs = Number(argValue(argv, "interval") ?? 5) * 1000;

  // One firing process per ledger (a second daemon would double-fire).
  const pidPath = join(ledger.dir, "serve.pid");
  if (existsSync(pidPath)) {
    const old = Number(readFileSync(pidPath, "utf8").trim());
    if (pidAlive(old)) {
      console.error(`dsc serve: already running (pid ${old})`);
      return 2;
    }
  }
  writeFileSync(pidPath, String(process.pid));

  const store = new SessionStore();
  const scheduler = new Scheduler({
    ledger,
    apiKey,
    baseUrl: process.env.DSC_BASE_URL ?? DEFAULT_BASE_URL,
    persist: (job: JobSpec, runId: string) => {
      // Dotted id: job sessions are resumable/inspectable via /resume but
      // hidden from the /sessions listing, same convention as sub-agents.
      const meta = store.create(job.model, job.cwd, `${job.id}.${runId}`);
      return { sessionId: meta.id, onMessage: (m) => store.appendMessage(meta.id, m) };
    },
    log: (line: string) => console.error(`[${new Date().toISOString()}] ${line}`),
  });

  console.error(`dsc serve: scheduling from ${ledger.jobsPath} every ${intervalMs / 1000}s (pid ${process.pid})`);
  let ticking = false;
  const iv = setInterval(() => {
    if (ticking) return; // a slow tick must not stack
    ticking = true;
    scheduler.tick(new Date()).catch((err) => console.error(`tick failed: ${String(err)}`)).finally(() => {
      ticking = false;
    });
  }, intervalMs);

  await new Promise<void>((resolveExit) => {
    const stop = (): void => {
      clearInterval(iv);
      console.error("dsc serve: shutting down, aborting live runs...");
      void scheduler.shutdown().then(() => resolveExit());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  store.close();
  rmSync(pidPath, { force: true });
  console.error("dsc serve: stopped");
  return 0;
}

function serveAlive(dir: string): boolean {
  const pidPath = join(dir, "serve.pid");
  if (!existsSync(pidPath)) return false;
  return pidAlive(Number(readFileSync(pidPath, "utf8").trim()));
}

function describeTrigger(t: Trigger): string {
  if (t.kind === "cron") return `cron "${t.expr}"`;
  if (t.kind === "watch") return `watch [${t.command}] every ${t.everySeconds}s`;
  return `once at ${fmtTime(t.at)}`;
}

function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
