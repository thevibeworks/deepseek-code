# Scheduled jobs (`dsc job`, `dsc ps`, `dsc serve`)

The proactive-agent pillar (DESIGN.md pillar 1): monitoring and scheduled
work built into the agent, not bolted on. A job is a prompt plus a
trigger plus a budget; each firing is an ordinary headless session you
can inspect and resume afterwards.

## Model

Two files under `$DSC_DATA_DIR` (default `~/.dsc/`):

- `jobs.json` — definitions. `dsc job add/rm` edit this, atomically
  (tmp+rename). Nothing else writes it.
- `job-runs.jsonl` — append-only events: `run_request` (from
  `dsc job run`), `run_start`, `run_end`. The daemon appends transitions
  the moment they happen, so `dsc ps` from another process sees a
  running job's session id mid-run.

Jobs fire ONLY inside a running `dsc serve`. Every other verb just edits
or reads the ledger — `dsc job run` appends a request and tells you if
no daemon is alive to honor it.

## Triggers

- `--cron "*/10 * * * *"` — five-field cron, vixie semantics (dom/dow
  both restricted = OR). Validated at add time by the same parser that
  fires it. A daemon that was down does not backfill missed boundaries.
- `--watch CMD --every N` — run CMD in the job's cwd every N seconds;
  exit 0 fires the job. File-glob watching is a command:
  `--watch 'test -n "$(find src -newer .last-sync)"'`.
- `--at TIMESTAMP` — one-shot; fires once ever, tracked across daemon
  restarts in the ledger.

A job still running when its trigger comes due is skipped, not queued.
Scheduled work should be idempotent; if it is not, do not schedule it.

## Budgets

Every firing runs under a hard envelope: `--max-turns` (default 24),
`--max-tokens` (total, default 300k), `--max-wall` seconds (default
300). A budget kill ends the run as `partial` with `killedBy` recorded;
the transcript survives in the session either way.

## Tool presets and the decision-file pattern

`--tools read` (default): the read tool plus bash restricted to an
inspection allowlist (`src/tools/classify.ts`) — no redirects, no
substitution, every pipeline segment must lead with an allowlisted
program, `git` limited to verbs with no writing form. This is accident
prevention with the honesty that implies: it stops a model doing the
obvious thing, it is not a sandbox against a hostile one.

`--tools write` adds edit/write and unrestricted bash. Use it with the
decision-file pattern, which is the actual safety model for unattended
work (we run it in production for the deepseek-docs sync agent):

1. The scheduled agent INVESTIGATES and writes a decision file
   (`.dsc-decisions/<job>.md` or similar): what it found, what should
   happen, evidence.
2. Side effects — commit, push, PR, deploy — live in a deterministic
   script that reads the decision file and does exactly one audited
   thing. That script runs from the notify hook or a separate cron, not
   from the agent.

The agent decides; a script you wrote executes. An agent that can push
directly will eventually push something you did not mean; a script
consuming a decision file cannot.

## Notifications

`--notify CMD` runs on every run end with `DSC_JOB`, `DSC_STATUS`
(done|partial|failed|cancelled), `DSC_RUN_ID`, `DSC_SESSION` in the
environment and the result text on stdin. A webhook is
`--notify 'curl -s -X POST -d @- https://...'`.

## Inspecting

- `dsc ps` — running now (with session ids) and the job table with next
  fire times and last results.
- `dsc job list` — definitions with last run per job.
- Every firing is a session: `dsc --resume <session-id>` opens it
  interactively; ids look like `<job>.<run-id>` and are hidden from the
  `/sessions` listing (same convention as sub-agent children).

## Failure honesty

- The daemon reaps stale `run_start` entries from a crashed daemon at
  startup (dead pid -> `cancelled` run_end) so a job is never blocked by
  a ghost.
- One corrupt ledger line is skipped, never fatal.
- A second `dsc serve` on the same data dir refuses to start (pid
  lockfile) — two daemons would double-fire every job.
