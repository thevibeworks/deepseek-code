#!/usr/bin/env bun
// dsc CLI — headless print mode + sessions.
//   dsc -p "prompt" [--model m] [--cwd dir] [--output-format text|json]
//       [--max-turns n] [--verbose] [--save] [--resume id]
//       [--context-budget tokens] [--subagents]
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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, MODELS } from "./provider/catalog";
import { addUsage } from "./provider/types";
import { runLoop } from "./engine/loop";
import type { RunResult } from "./engine/loop";
import { SubagentManager } from "./engine/subagent";
import { Session } from "./session/session";
import { SessionStore } from "./session/store";
import { readTool } from "./tools/read";
import { bashTool } from "./tools/bash";
import { editTool } from "./tools/edit";
import { writeTool } from "./tools/write";
import { makeTaskTool } from "./tools/task";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const promptIdx = process.argv.indexOf("-p");
const prompt = promptIdx >= 0 ? process.argv[promptIdx + 1] : undefined;
if (!prompt) {
  console.error(
    'usage: dsc -p "prompt" [--model m] [--cwd dir] [--output-format text|json] [--max-turns n] [--verbose]',
  );
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

function resolveApiKey(): string | null {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const keyFile = join(homedir(), ".dsc", "key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  return null;
}
const apiKey = resolveApiKey();
if (!apiKey) {
  console.error("dsc: no API key ($DEEPSEEK_API_KEY or ~/.dsc/key)");
  process.exit(2);
}

const t0 = Date.now();
const baseUrl = process.env.DSC_BASE_URL ?? DEFAULT_BASE_URL;

// Session setup happens before tool assembly: child persistence closes
// over the store, and the task tool closes over the manager.
let store: SessionStore | undefined;
let session: Session | undefined;
let sessionId: string | undefined;
if (save || resumeId !== undefined) {
  store = new SessionStore();
  const s =
    resumeId !== undefined ? Session.resume(store, resumeId) : Session.create(store, model, cwd);
  if (s === null) {
    console.error(`dsc: no session "${resumeId}"`);
    process.exit(2);
  }
  session = s;
  sessionId = s.meta.id;
}

const manager = new SubagentManager({
  apiKey,
  baseUrl,
  cwd,
  contextBudget,
  ...(store !== undefined
    ? {
        persist: (childId: string, childModel: string) => {
          const meta = store!.create(childModel, cwd, `${sessionId}.${childId}`);
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

const tools = subagents
  ? [readTool, bashTool, editTool, writeTool, makeTaskTool(manager)]
  : [readTool, bashTool, editTool, writeTool];

const runOpts = {
  model,
  cwd,
  apiKey,
  baseUrl,
  tools,
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

let result: RunResult;
if (session !== undefined) {
  result = await session.run(prompt, runOpts);
} else {
  result = await runLoop({ ...runOpts, prompt });
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
