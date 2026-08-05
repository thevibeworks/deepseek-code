# deepseek-code (`dsc`)

A DeepSeek-native coding agent for the v4 flash/pro series. TypeScript,
Bun, zero runtime dependencies.

Not a Claude Code clone and not a general multi-provider harness. Being
DeepSeek-only is the design: one protocol state machine (the
Anthropic-compatible Messages API v4 is trained toward), one pricing
table, one cache model. That is what keeps this a few thousand lines
instead of a few hundred thousand.

**Status: work in progress.** The agent loop, tools, context engine,
sessions/compaction, sub-agents, and interactive mode work and are
eval-gated. Interfaces will move.

## Install / run

Requires [Bun](https://bun.sh) and a DeepSeek API key.

```bash
export DEEPSEEK_API_KEY=sk-...          # or write it to ~/.dsc/key

bun src/cli.ts                          # interactive
bun src/cli.ts -p "fix the failing test in src/parse.js"   # one shot
```

Interactive is the default. Sessions are on automatically there, so
`--continue` picks up where the last one in this directory left off.
Ctrl-C interrupts a turn without losing the session; Ctrl-D leaves.
Commands: `/help /seek /status /cost /model /compact /clear /sessions
/resume /thinking /exit`.

`/seek <question>` investigates in parallel: it plans a split, spawns one
sub-agent per piece *before* reading anything itself, then synthesizes
the reports. It refuses to fan out when a question is not genuinely
decomposable — read the numbers below before reaching for it.

Piped input works too, which makes scripted multi-turn runs easy:

```bash
printf 'read src/parse.js\nnow fix the regex\n/cost\n' | bun src/cli.ts
```

Useful flags:

```
--model deepseek-v4-flash|deepseek-v4-pro
--cwd DIR                 working directory for the run
--continue                interactive: resume the latest session here
--save / --resume ID      persist the session to SQLite (~/.dsc/)
--output-format text|json -p only; JSON is the machine surface (eval/)
--context-budget N        lower the autocompaction threshold
--subagents               enable the task tool (off by default; see below)
--thinking                interactive: stream reasoning by default
--verbose                 -p only; stream progress to stderr
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
- **Interactive mode** (`src/ui/`) — a line-based conversation, no TUI
  dependency. The renderer is a pure projection of the agent event
  stream, so `-p` still runs with no renderer attached. Interrupting a
  turn leaves a *resumable* session: a cancelled tool batch still pairs
  every tool call with a result, because an orphaned result is an
  invalid payload on the next prompt.
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

**`/seek` does not make investigation faster.** It is the explicit
delegation mode M4 concluded was needed, and it works — but measured
against a single agent on the same question, twice, it lost on
wall-clock both times (33.0s → 96.7s on a shallow six-service fixture;
70.2s → 97.5s on a deep audit of this repo's own source). Fan-out cannot
compress the serial chain of plan → slowest child → synthesize below what
one agent that greps well already does.

What it does buy is thoroughness and context scaling: ~30% fewer input
tokens for the parent on the deep case, and N independent investigations
each with a full context budget rather than six services sharing one.
Reach for it when a question is too big for one context, not when you are
in a hurry. Both measurements are n=1 and indicative only;
`docs/devlog/2026-08-05-m6-seek.org` has the full numbers and the two
bugs found getting there.

**Interactive mode does not save you tokens.** The premise it was built
on — "one process keeps the prefix cache warm" — is false: the cache is
server-side and cross-process. A second process sending identical bytes
read 3840 of 3945 input tokens from cache, so `-p --resume` was already
getting the same discount. Interactive earns its place on latency and
control, not cost. The measurement is in
`docs/devlog/2026-08-05-m5-interactive.org`.

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
