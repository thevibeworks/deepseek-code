#!/usr/bin/env bun
// Matrix runner: (task, adapter, model) x N -> runs.jsonl.
// Usage:
//   bun run.ts --tasks bugfix-slugify,feature-tdd --adapters dsc \
//     --models deepseek-v4-flash --n 3
// Design: deepseek-code/EVAL.md. One run = fresh fixture copy -> headless
// invocation -> dumb bash verifier -> metrics row. Sequential on purpose:
// DeepSeek's prefix cache is time-sensitive and parallel runs would blur
// cache-hit measurements.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export type Usage = { inputFresh: number; cacheRead: number; output: number };
export type AdapterResult = {
  exitCode: number;
  timedOut: boolean;
  wallMs: number;
  apiMs: number | null;
  turns: number | null;
  resultText: string;
  usage: Usage | null;
  raw: unknown;
};
export type Adapter = {
  name: string;
  run(opts: {
    prompt: string;
    model: string;
    workdir: string;
    timeoutMs: number;
    env?: Record<string, string>;
  }): Promise<AdapterResult>;
};

const EVAL_DIR = import.meta.dir;
const RUNS_FILE = join(EVAL_DIR, "runs.jsonl");
const TRANSCRIPTS = join(EVAL_DIR, "transcripts");

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const taskArg = arg("tasks", "all");
const taskNames =
  taskArg === "all"
    ? readdirSync(join(EVAL_DIR, "tasks"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : taskArg.split(",");
const adapterNames = arg("adapters", "dsc").split(",");
const models = arg("models", "deepseek-v4-flash").split(",");
const n = parseInt(arg("n", "1"), 10);

const pricing = await Bun.file(join(EVAL_DIR, "pricing.json")).json();
function costUsd(model: string, u: Usage | null): number | null {
  const p = pricing.models[model];
  if (!p || !u) return null;
  return (u.inputFresh * p.input_miss + u.cacheRead * p.input_hit + u.output * p.output) / 1e6;
}

mkdirSync(TRANSCRIPTS, { recursive: true });

for (const adapterName of adapterNames) {
  const adapter: Adapter = (await import(`./adapters/${adapterName}.ts`)).default;
  for (const taskName of taskNames) {
    const taskDir = join(EVAL_DIR, "tasks", taskName);
    const task = await Bun.file(join(taskDir, "task.json")).json();
    for (const model of models) {
      for (let i = 1; i <= n; i++) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const runId = `${stamp}-${taskName}-${adapterName}-${model}-${i}`;
        const workdir = mkdtempSync(join(tmpdir(), "dsc-eval-"));
        cpSync(join(taskDir, "fixture"), workdir, { recursive: true });

        const res = await adapter.run({
          prompt: task.prompt,
          model,
          workdir,
          timeoutMs: task.timeout_ms ?? 240000,
          ...(task.env !== undefined ? { env: task.env } : {}),
        });

        const resultFile = join(TRANSCRIPTS, `${runId}.result.txt`);
        writeFileSync(resultFile, res.resultText ?? "");
        writeFileSync(join(TRANSCRIPTS, `${runId}.json`), JSON.stringify(res.raw, null, 2));

        let verifyExit = 1;
        if (!res.timedOut && existsSync(join(taskDir, "verify.sh"))) {
          const v = Bun.spawnSync(["bash", join(taskDir, "verify.sh"), resultFile], { cwd: workdir });
          verifyExit = v.exitCode;
        }

        const u = res.usage;
        const row = {
          ts: new Date().toISOString(),
          task: taskName,
          adapter: adapterName,
          model,
          iter: i,
          success: verifyExit === 0,
          timed_out: res.timedOut,
          exit_code: res.exitCode,
          wall_ms: res.wallMs,
          api_ms: res.apiMs,
          turns: res.turns,
          tokens: u ? { input_fresh: u.inputFresh, cache_read: u.cacheRead, output: u.output } : null,
          cache_hit_pct: u && u.inputFresh + u.cacheRead > 0
            ? Math.round((100 * u.cacheRead) / (u.inputFresh + u.cacheRead))
            : null,
          cost_usd: costUsd(model, u),
          transcript: `transcripts/${runId}.json`,
        };
        appendFileSync(RUNS_FILE, JSON.stringify(row) + "\n");
        console.log(
          `${row.success ? "PASS" : "FAIL"}  ${taskName} ${adapterName} ${model} #${i}  ` +
            `${(res.wallMs / 1000).toFixed(1)}s  turns=${res.turns ?? "?"}  ` +
            `cache=${row.cache_hit_pct ?? "?"}%  $${row.cost_usd?.toFixed(4) ?? "?"}` +
            (res.timedOut ? "  TIMEOUT" : ""),
        );
        rmSync(workdir, { recursive: true, force: true });
      }
    }
  }
}
