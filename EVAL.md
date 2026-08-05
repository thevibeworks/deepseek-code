# deepseek-code — eval harness design

Draft v1, 2026-08-03. Companion to DESIGN.md. Goal: a reusable workflow
that answers, with numbers, "does harness X run DeepSeek better than
harness Y?" — and gates every dsc engine change.

> Status 2026-08-03: implemented in `eval/` — run.ts, report.ts,
> pricing.json (from deepseek-docs mirror), adapters, tasks
> bugfix-slugify / feature-tdd / explore-answer. Baselines in
> `eval/runs.jsonl`. Not yet built: claude-official/dsc/codex adapters,
> refactor-safe + long-context tasks.

## Shape

```
eval/
  tasks/<name>/
    task.json        prompt, timeout, budget, tags
    fixture/         pristine workdir (copied per run)
    verify.sh        deterministic pass/fail + optional score on stdout
  adapters/<harness>.ts   command template + usage extraction
  pricing.json       DeepSeek price table (per-model, hit/miss/output)
  run.ts             matrix runner -> runs.jsonl
  report.ts          runs.jsonl -> markdown matrix
```

One run = (task, harness, model) -> fresh fixture copy -> headless
invocation with timeout -> verifier -> metrics row appended to
`runs.jsonl`. N=3 per cell minimum; report medians + spread, flag
high-variance cells. Never average successes with failures — success
rate and cost-given-success are separate columns.

## Adapters (initial)

| Adapter | What it drives | Status |
|---|---|---|
| `dsc` | our CLI, default path (no sub-agents) | works today |
| `dsc-fanout` | our CLI with `--subagents` (the fan-out arm) | works today |
| `claude-official` | official `claude` npm CLI + env retarget to DeepSeek (the claude-code-action recipe) | ready to write |
| `codex` | codex CLI via DeepSeek OpenAI-compat endpoint | to probe |
| `pi` / `oh-my-pi` | optional, per research docs they cache well | later |

Adapter contract: `run(task, model, workdir) -> { transcriptPath?,
usage: {input, output, cacheRead}, turns?, toolCalls?, wallMs, apiMs?,
exitCode }`. Usage MUST come from the harness's own reporting (JSON
output modes); cost is always recomputed from `pricing.json` — bench
finding: retargeted Claude harnesses overstate DeepSeek cost ~13x,
and any harness's cost
field is suspect by default.

## Task suite (v1: five tasks, grow honestly)

1. `bugfix-slugify` — the bench task: failing test, find/fix/verify.
   Verify: `node test.js` exits 0 AND the original bug line changed.
2. `feature-tdd` — implement a small module against a provided test
   file. Verify: tests pass, no test-file edits (checksum).
3. `explore-answer` — question about a medium repo with an exact
   checkable answer (grep-able fact). Verify: answer string match.
   Measures exploration efficiency (tool calls, tokens).
4. `refactor-safe` — rename/restructure with tests as invariant.
   Verify: tests pass + old symbol gone.
5. `long-context` — task engineered to exceed the context budget and
   force compaction mid-run (reasonix's compaction e2e idea). Verify:
   final answer references facts from before the compaction point.

Rules: fixtures are self-contained (no network), verifiers are dumb
bash, tasks tagged (quick/agentic/context) so CI can run subsets.

## Metrics per run

```
success        verifier exit (primary; everything else conditions on it)
wall_ms        end-to-end
api_ms         harness-reported when available
turns          assistant turns
tool_calls     total tool invocations
tokens         input_fresh, cache_read, output   (harness usage report)
cache_hit_pct  cache_read / (cache_read + input_fresh)
cost_usd       recomputed from pricing.json, never harness-reported
```

Headline comparison metric: **cost per solved task** and **tokens per
solved task**, at equal success rate. Cache-hit% is diagnostic, not a
goal (research consensus: hit-rate alone is gameable — compaction can
lower hit% while improving quality and total cost).

## Workflow

- `bun eval/run.ts --tasks all --adapters dsc --models deepseek-v4-flash
  --n 3` -> appends runs.jsonl
- `bun eval/report.ts` -> matrix like evot's README table.
- CI (dsc repo): quick-tag tasks on every engine PR; full matrix
  nightly. Engine PRs paste the delta table (evot's "numbers decide").
- Baseline discipline: adapter+model baselines are recorded once and
  pinned; re-baseline is an explicit, reviewed act (DeepSeek-TUI's
  budget re-baseline pattern).

## Honesty rules

- Self-reported anecdotes (HN-style) never enter runs.jsonl.
- A task that any adapter passes trivially in 1 turn gets hardened or
  demoted to smoke.
- Variance > 30% on a cell -> raise N before drawing conclusions.
- The harness runs the SAME model for all adapters in a comparison row;
  cross-model comparisons are a separate report, never mixed inline.
