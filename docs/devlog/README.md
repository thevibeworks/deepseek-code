# Devlog

Decision chain, not a changelog. Each entry reconstructs *why* something
is the way it is: the tension, what was observed, what was decided, what
it cost, and what was left open. Git records what changed; these record
why.

Entries present here:

- `2026-08-04-design-review-pi-round-4.org` — design review against the
  pi research; the Round 4 deltas that shaped M2-M4.
- `2026-08-05-m4-subagents.org` — sub-agents: the task tool, roles and
  budget envelopes, and four findings, including two that overturned
  earlier conclusions in the same document. Read Finding 4 before
  trusting the earlier verdict; the wrong turn is left visible on
  purpose.
- `2026-08-05-m5-interactive.org` — interactive mode: why it is not a
  TUI, the two terminal-input traps (both measured, both wrong in
  opposite directions), a `kill` bug that had been quietly breaking
  command timeouts all along, and the token-cost premise for the whole
  milestone turning out to be false.
- `2026-08-05-m6-seek.org` — `/seek`, the explicit delegation mode M4
  said was the missing structural lever. Two bugs worth reading (a
  planner that refused because it had never seen the repo; reasoning
  tokens silently eating the plan and looking like a refusal), and the
  measurement that it does not buy speed.
- `2026-08-05-m7-scheduler.org` — scheduled jobs: one cron parser for
  add and fire, the two-file ledger, the read-only preset built on a
  classifier ported from the Go sibling (with the holes found porting
  it), and why serve ships without HTTP.

Entries for M1-M3 are held back for now: they are written around a
private comparison harness (a proprietary agent CLI retargeted to
DeepSeek) that cannot be published, and they are entangled with it
paragraph by paragraph rather than in a way a search-and-replace can
fix honestly. The engineering conclusions from those milestones survive
in `DESIGN.md`, `eval/BASELINE.md`, and the source comments.
