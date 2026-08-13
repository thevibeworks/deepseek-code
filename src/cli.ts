#!/usr/bin/env bun
// dsc CLI — interactive mode + headless print mode + sessions.
//   dsc                      interactive (sessions ON, see ui/repl.ts)
//   dsc -p "prompt" [--model m] [--cwd dir] [--output-format text|json]
//       [--max-turns n] [--verbose] [--save] [--resume id]
//       [--context-budget tokens] [--subagents]
// With no -p we start a conversation. Note what this does NOT buy: the
// prefix cache is server-side and cross-process (measured — a second
// process sending identical bytes read 3840/3945 tokens from cache), so
// `-p --resume` is not paying more for tokens. Interactive earns its keep
// on ergonomics and latency: no process start, no view rebuilt from
// SQLite per prompt, and interrupts that leave a resumable session.
// Sub-agents are opt-in (--subagents / $DSC_SUBAGENTS=1): the parent then
// gets the task tool (spawn/wait/result/cancel); children never get it
// (depth 1, no nesting). Reported usage totals include child usage.
// Default-off is an eval decision, not an oversight — see BASELINE.md
// "parallel-fix" (three prompt regimes) and "parallel-explore".
// Sessions persist to $DSC_DATA_DIR/sessions.db (default ~/.dsc/) only
// with --save/--resume; plain -p stays ephemeral. Autocompaction is
// always armed at the model's measured input budget; --context-budget
// (or $DSC_CONTEXT_BUDGET) lowers it — the compaction eval uses this.
// JSON output is the adapter surface for eval/ (usage fields feed
// eval/run.ts; cost is deliberately NOT reported here — recompute from
// eval/pricing.json, never trust harness cost fields).
// Key resolution: $DEEPSEEK_API_KEY, else ~/.dsc/key.

import { resolve } from "node:path";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, MODELS } from "./provider/catalog";
import { resolveApiKey } from "./config";
import { schedulerCli } from "./scheduler/cli";
import { addUsage } from "./provider/types";
import { runLoop } from "./engine/loop";
import type { RunResult } from "./engine/loop";
import { SubagentManager } from "./engine/subagent";
import { Session } from "./session/session";
import { SessionStore } from "./session/store";
import { discoverSkills } from "./skills/discover";
import { readTool } from "./tools/read";
import { bashTool } from "./tools/bash";
import { editTool } from "./tools/edit";
import { writeTool } from "./tools/write";
import { makeTaskTool } from "./tools/task";
import { makeSkillTool } from "./tools/skill";
import { runRepl } from "./ui/repl";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const USAGE = `usage:
  dsc                          interactive session in the current directory
  dsc -p "prompt"              one-shot, print the result and exit
  dsc job|ps|serve             scheduled jobs (dsc job for details)
  dsc skills                   discovered SKILL.md skills and their sources

  --model NAME                 ${Object.keys(MODELS).join(" | ")}
  --cwd DIR                    working directory for the run
  --continue                   interactive: resume the latest session here
  --resume ID                  resume a specific session
  --save                       persist a -p run (interactive always saves)
  --subagents                  enable the task tool (see BASELINE.md)
  --context-budget N           lower the autocompaction threshold
  --thinking                   interactive: stream reasoning by default
  --max-turns N                cap turns in a single run
  --output-format text|json    -p only; json is the machine surface
  --verbose                    -p only; stream progress to stderr
  --help`;

if (hasFlag("help")) {
  console.log(USAGE);
  process.exit(0);
}

// Scheduler verbs dispatch before everything else: they neither need a
// prompt nor (except serve) an API key, and they must never fire a job.
if (["job", "ps", "serve"].includes(process.argv[2] ?? "")) {
  process.exit(await schedulerCli(process.argv.slice(2)));
}

// `dsc skills` — what discovery found and from where, no API key needed.
// The listing shows exactly what the session index will carry; a skipped
// or shadowed SKILL.md is reported here rather than silently absent.
if (process.argv[2] === "skills") {
  const dir = resolve(argValue("cwd") ?? process.cwd());
  const found = discoverSkills(dir);
  for (const w of found.warnings) console.error(`warning: ${w}`);
  if (found.skills.length === 0) {
    console.log(
      "no skills (searched <project>/.dsc/skills, <project>/.agents/skills, ~/.dsc/skills, ~/.agents/skills)",
    );
  }
  for (const s of found.skills) {
    console.log(`${s.name}  [${s.source}]`);
    console.log(`    ${s.description}`);
    console.log(`    ${s.path}`);
  }
  process.exit(0);
}

const promptIdx = process.argv.indexOf("-p");
const prompt = promptIdx >= 0 ? process.argv[promptIdx + 1] : undefined;
const interactive = prompt === undefined;
if (promptIdx >= 0 && prompt === undefined) {
  console.error("dsc: -p needs a prompt");
  process.exit(2);
}

const model = argValue("model") ?? process.env.DSC_MODEL ?? DEFAULT_MODEL;
if (!MODELS[model]) {
  console.error(`dsc: unknown model "${model}" (known: ${Object.keys(MODELS).join(", ")})`);
  process.exit(2);
}
const cwd = resolve(argValue("cwd") ?? process.cwd());
const outputFormat = argValue("output-format") ?? "text";
const maxTurns = Number(argValue("max-turns") ?? 100);
const verbose = hasFlag("verbose");
const save = hasFlag("save");
const resumeId = argValue("resume");
// Sub-agents are OPT-IN. Not because they lose — on deep independent
// subtasks with EARLY delegation they win wall-clock 1.30x at +67% cost
// (BASELINE.md parallel-fix regime A). Because flash never reaches for
// them on its own: with the tool present and a guideline telling it to
// delegate before investigating, it spawned nothing in 3/3 runs
// (regime C). Default-on would be inert prefix weight, so the feature is
// caller-driven. Off by default also keeps the default prompt
// byte-identical to the M1-gated prefix.
const subagents = hasFlag("subagents") || process.env.DSC_SUBAGENTS === "1";
const contextBudget = Number(
  argValue("context-budget") ?? process.env.DSC_CONTEXT_BUDGET ?? MODELS[model].inputBudget,
);

const apiKey = resolveApiKey();
if (!apiKey) {
  console.error("dsc: no API key ($DEEPSEEK_API_KEY or ~/.dsc/key)");
  process.exit(2);
}

// Skills are discovered ONCE per process, so the system prompt is
// byte-stable across every run of a session (the epoch rule: the index
// never re-renders mid-session). With nothing discovered, no skill tool
// is registered and the prompt stays byte-identical to the gated golden.
const skillset = discoverSkills(cwd);
for (const w of skillset.warnings) console.error(`dsc: skills: ${w}`);

const t0 = Date.now();
const baseUrl = process.env.DSC_BASE_URL ?? DEFAULT_BASE_URL;

// Session setup happens before tool assembly: child persistence closes
// over the store, and the task tool closes over the manager.
// Interactive ALWAYS persists — a conversation you cannot resume is one
// you lose to a closed terminal, and the rows cost a few KB.
let store: SessionStore | undefined;
let session: Session | undefined;
let sessionId: string | undefined;
if (interactive || save || resumeId !== undefined) {
  store = new SessionStore();
  let target = resumeId;
  if (target === undefined && hasFlag("continue")) {
    const latest = store.list({ cwd, limit: 1 })[0];
    if (latest === undefined) {
      console.error(`dsc: no previous session in ${cwd}`);
      process.exit(2);
    }
    target = latest.id;
  }
  const s = target !== undefined ? Session.resume(store, target) : Session.create(store, model, cwd);
  if (s === null) {
    console.error(`dsc: no session "${target}"`);
    process.exit(2);
  }
  session = s;
  sessionId = s.meta.id;
}

// A manager is per RUN, not per process: MAX_CHILDREN is a per-run limit,
// and interactive mode does many runs. `-p` makes exactly one.
let runOrdinal = 0;
const makeManager = (): SubagentManager => {
  const run = ++runOrdinal;
  return new SubagentManager({
    apiKey,
    baseUrl,
    cwd,
    contextBudget,
    ...(store !== undefined
      ? {
          // Child ids restart at t1 every run, so the run ordinal keeps
          // stored child session ids unique across an interactive session.
          persist: (childId: string, childModel: string) => {
            const meta = store!.create(childModel, cwd, `${sessionId}.r${run}${childId}`);
            return {
              sessionId: meta.id,
              onMessage: (m: any) => store!.appendMessage(meta.id, m),
            };
          },
        }
      : {}),
    ...(verbose
      ? {
          onLifecycle: (rec: any, phase: string) =>
            process.stderr.write(
              phase === "spawn"
                ? `\n[task ${rec.id}] spawned (${rec.role})\n`
                : `\n[task ${rec.id}] ${rec.status} (${rec.turns} turns, ${Math.round(rec.wallMs / 1000)}s)\n`,
            ),
        }
      : {}),
  });
};

// The task TOOL stays opt-in (it changes the prompt); /seek drives the
// same machinery from the frontend, so it needs no tool and no re-gate.
// The skill tool registers only when discovery found something — same
// rule, same reason: an inert tool would be dead prefix weight.
const makeTools = (mgr: SubagentManager) => [
  readTool,
  bashTool,
  editTool,
  writeTool,
  ...(subagents ? [makeTaskTool(mgr)] : []),
  ...(skillset.skills.length > 0 ? [makeSkillTool(skillset.skills)] : []),
];

if (interactive) {
  const code = await runRepl({
    store: store!,
    session: session!,
    makeManager,
    makeTools,
    skills: skillset.skills,
    model,
    cwd,
    apiKey,
    baseUrl,
    maxTurns,
    contextBudget,
    thinking: hasFlag("thinking"),
  });
  // The REPL owns a manager per turn and drains it there; nothing of its
  // own is left running at this point.
  store!.close();
  process.exit(code);
}

const manager = makeManager();
const runOpts = {
  model,
  cwd,
  apiKey,
  baseUrl,
  tools: makeTools(manager),
  skills: skillset.skills,
  maxTurns,
  contextBudget,
  onEvent: verbose
    ? (e: any) => {
        if (e.type === "text_delta") process.stderr.write(e.text);
        else if (e.type === "tool_execution_start")
          process.stderr.write(`\n[tool] ${e.name} ${JSON.stringify(e.input).slice(0, 200)}\n`);
        else if (e.type === "compaction")
          process.stderr.write(
            `\n[compaction] ${e.contextTokensBefore} -> ${e.contextTokensAfter} tokens (${e.llm ? "llm" : "emergency"} summary)\n`,
          );
        else if (e.type === "turn_end") process.stderr.write("\n");
      }
    : undefined,
};

// Past the interactive branch, so -p was given.
const task = prompt as string;
let result: RunResult;
if (session !== undefined) {
  result = await session.run(task, runOpts);
} else {
  result = await runLoop({ ...runOpts, prompt: task });
}
// Children never outlive the parent run; a spawned-but-never-awaited
// child is cancelled here and its partial usage still counts.
manager.cancelAll();
await manager.wait();
store?.close();
const totalUsage = addUsage(result.usage, manager.totalUsage());
const wallMs = Date.now() - t0;

if (outputFormat === "json") {
  console.log(
    JSON.stringify({
      result: result.resultText,
      end_reason: result.endReason,
      ...(result.errorMessage !== undefined ? { error_message: result.errorMessage } : {}),
      model,
      num_turns: result.turns,
      num_compactions: result.compactions,
      num_subagents: manager.count(),
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      duration_ms: wallMs,
      duration_api_ms: result.apiMs,
      // Usage totals INCLUDE sub-agent usage — cost comparisons lie otherwise.
      usage: {
        input_tokens: totalUsage.inputFresh,
        cache_read_input_tokens: totalUsage.cacheRead,
        output_tokens: totalUsage.output,
      },
      messages: result.messages,
    }),
  );
} else {
  if (result.resultText !== "") console.log(result.resultText);
  if (sessionId !== undefined) console.error(`dsc: session ${sessionId}`);
  if (result.endReason !== "completed") {
    console.error(`dsc: run ended: ${result.endReason}${result.errorMessage ? ` (${result.errorMessage})` : ""}`);
  }
}
process.exit(result.endReason === "completed" ? 0 : 1);
