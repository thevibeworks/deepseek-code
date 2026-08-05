# deepseek-code (`dsc`)

A DeepSeek-native coding agent for the v4 flash/pro series. TypeScript,
Bun, zero runtime dependencies.

Not a Claude Code clone and not a general multi-provider harness. Being
DeepSeek-only is the design: one protocol state machine (the
Anthropic-compatible Messages API v4 is trained toward), one pricing
table, one cache model. That is what keeps this a few thousand lines
instead of a few hundred thousand.

**Status: work in progress.** The agent loop, tools, context engine,
sessions/compaction, and sub-agents work and are eval-gated. There is no
TUI yet. Interfaces will move.

## Install / run

Requires [Bun](https://bun.sh) and a DeepSeek API key.

```bash
export DEEPSEEK_API_KEY=sk-...          # or write it to ~/.dsc/key
bun src/cli.ts -p "fix the failing test in src/parse.js"
```

Useful flags:

```
--model deepseek-v4-flash|deepseek-v4-pro
--cwd DIR                 working directory for the run
--output-format text|json JSON is the machine surface (used by eval/)
--save / --resume ID      persist the session to SQLite (~/.dsc/)
--context-budget N        lower the autocompaction threshold
--subagents               enable the task tool (off by default; see below)
--verbose                 stream reasoning, tool calls and compactions to stderr
```

## What is actually built

- **Provider** (`src/provider/`) — streaming client for the `/anthropic`
  endpoint. The stream function never throws: transport and protocol
  failures arrive as a final message with `stopReason: "error"`, so a
  crashed turn can never poison the next payload. Includes DSML healing
  for tool calls the model emits as markup rather than structured blocks.
- **Loop** (`src/engine/loop.ts`) — the turn machine. A truncated
  response fails its *entire* tool batch rather than executing possibly
  incomplete arguments. Everything that happens "between turns" goes
  through one named seam (`TurnSeam`) instead of being inlined.
- **Context engine** — output spilling instead of truncation, read
  deduplication, doom-loop detection, tool-result reclaim at run
  boundaries, and a context meter. History is append-only and messages
  are immutable once appended, so prefix-cache byte stability holds by
  construction.
- **Sessions + compaction** (`src/session/`, `src/engine/compact.ts`) —
  SQLite via `bun:sqlite`. Compaction shrinks the context *view*, never
  storage. A deterministic emergency summary is always available with
  zero model calls; an LLM summary upgrades it when the call succeeds.
- **Sub-agents** (`src/engine/subagent.ts`, `src/tools/task.ts`) — one
  `task` tool with spawn/wait/result/cancel, roles as
  prompt+permission+model presets, and budget envelopes (turns, tokens,
  wall-clock). Off by default; see below for why.
- **Eval harness** (`eval/`) — the part that decides what stays.

## Everything here is eval-gated

Engine changes must hold or improve success, tokens, and cost on a
pinned benchmark suite. Numbers decide; taste does not. See
`eval/BASELINE.md` for the pinned baselines and `eval/runs.jsonl` for
the raw rows behind them.

```bash
bun eval/run.ts --tasks all --adapters dsc --models deepseek-v4-flash --n 3
bun eval/report.ts
```

Two findings worth surfacing, both of which contradicted an assumption
we started with:

**Compaction can silently lose the task.** After two compaction rounds
an agent was observed running `find . -iname '*task*'` — searching the
filesystem for its own prompt — and then livelocking. Summaries erode
across rounds, and the original ask erodes with them. The fix pins the
task verbatim into every compacted view. Compaction that preserves
"what happened" but loses "what we were asked" is worse than useless.

**Sub-agents: delegation timing decides everything.** On four
independent sub-tasks, delegating *before* investigating beat a single
agent by 1.30x on wall-clock. Delegating *after* the parent had already
read the material — same mechanism, same fixture, only the timing of
the instruction differed — was 2.08x *slower*, because the context gets
paid for twice: once by the parent, once by children re-reading it. On
shallow lookups, fan-out loses badly (2.49x wall, 6.75x cost): per-child
fixed overhead simply exceeds per-child work.

Sub-agents are therefore **opt-in** (`--subagents`), and the honest
reason is not that they lose. It is that the model never reaches for
them on its own — with the tool present *and* a guideline explicitly
telling it to delegate before investigating, it spawned nothing in 3/3
runs. Delegation is a caller-driven feature here, not an autonomous
behavior. Full numbers: `eval/BASELINE.md`, section `parallel-fix`.

## Tests

```bash
bun test tests
```

The system prompt is byte-frozen by `tests/prompt-golden.test.ts`.
Prompt wording is behavior — an earlier guideline reading "minimal,
surgical changes" steered the model into appending compensating code
instead of fixing a bad regex, and cost a third of the runs on one task.
Changing those bytes is a deliberate, eval-gated act, not a tidy-up.

## Documentation

- `DESIGN.md` — the full design and its reasoning.
- `EVAL.md` — how the benchmark harness is put together.
- `eval/BASELINE.md` — pinned baselines, with the caveats that make them
  readable (including where variance makes a number untrustworthy).
- `docs/devlog/` — the decision chain: why things are the way they are,
  including the wrong turns.
- `docs/research/` — deep-dive notes on the open-source agents studied
  while designing this (pi, opencode, goose).

## Credit

Loop and tool contracts were ported from
[pi](https://github.com/earendil-works/pi) (MIT, Mario Zechner) — the
truncated-batch rule, source-order tool results, the never-throwing
stream function, and the between-turns seam. Ideas were also studied
from opencode and goose. Those are decisions ported deliberately, not
code copied wholesale; where behavior came from a proprietary harness it
was reimplemented from observed behavior only.

## License

MIT — see `LICENSE`.
