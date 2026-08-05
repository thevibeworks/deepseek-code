# deepseek-pi (Go sibling) vs dsc core — comparison

2026-08-05. Sources: dsc `src/` at 899729a read in full; deepseek-pi at
dd0574d (github.com/thevibeworks/deepseek-pi), core packages mapped
file-by-file. Both projects target DeepSeek v4 flash/pro over the
`/anthropic` endpoint and both ported the pi (earendil-works/pi) loop
contracts, so the interesting content is where they diverge.

Sizes: deepseek-pi core (agent+harness+ai+tools) ~13.5k lines Go, one
runtime dep (`golang.org/x/text`). dsc `src/` ~4.2k lines TS, zero deps.
The 3x gap is real surface, not padding — the sections below name it.

## Shared spine (independently converged or both ported from pi)

Identical decisions, implemented separately, agreeing on the details:

- Anthropic-protocol wire code owned, no vendor SDK; `x-api-key` auth
  (not bearer — the classic porting trap).
- Stream function never throws/errors; failures are a final message with
  an error stop reason. Errored/aborted turns stay in the transcript and
  are scrubbed from provider payloads.
- `stopReason=length` with tool calls fails the ENTIRE batch (truncated
  args can parse yet be incomplete); the model re-issues.
- Two retry layers outside the loop: transport (429/5xx, Retry-After
  capped at 60s) and session (classifier, backoff, fatal-first matching).
- Byte-stable system prompt: deterministic assembly, tool docs live on
  the tool definition, cwd is the last line, CI-guarded.
- Two-tier token accounting: provider usage anchors, len/4 estimates
  only the trailing delta; stale usage zeroed on resume/retain or
  autocompact re-triggers forever (both learned this one).
- Compaction shrinks the view, never storage; deterministic emergency
  summary always available; LLM summary UPDATES the previous summary.
- Sub-agents: roles as presets, budget envelopes (turns/tokens/wall),
  recursion prevented structurally by omitting the task tool from child
  toolsets, only the final report returns to the parent.
- Edit: multi-edit-native schema, arg healing, exact-then-fuzzy match
  (NFKC + quotes/dashes/spaces), matches original bytes, non-unique is
  an error, pedagogical failure strings.
- Bash: process-group kill (orphaned grandchildren hold the pipe),
  spill-to-disk decided during streaming, tail-biased truncation with
  actionable notices.
- Catalog: 616k usable / 1M advertised, real pricing, cost computed from
  token counts only — never a harness cost field.

Convergence this complete is evidence both readings of the wire are
right; treat the shared spine as settled.

## Where the Go sibling is ahead (real capability gaps in dsc)

1. Permissions + workspace scoping — dsc has NONE. deepseek-pi has the
   full chain: yolo -> bash allowlist classification -> non-mutating
   passthrough -> plan mode (checked BEFORE allow-list, "a mode another
   setting can escape is not a mode") -> remembered -> ask; headless ask
   degrades to a refusal with an actionable message. Workspace scoping
   symlink-resolves both sides; per-file locks keyed on resolved paths.
   dsc tools resolve any absolute path anywhere and every run is
   effectively yolo. Matters most for the scheduler milestone, where
   runs are unattended by design.
2. Steering / follow-up queues. pi's inner/outer loop injects user input
   at the between-turns seam mid-run; dsc's only mid-run control is
   Ctrl-C. dsc's TurnSeam is the named place for this; it's empty of
   steering today.
3. Branching, rewind, workspace checkpointing. Content-addressed blob
   store, and the two-snapshot honesty rule: restore from the EARLIEST
   snapshot at/after the cut, authorize from the LATEST (on-disk bytes
   must hash-equal what the agent last wrote, else "kept" with a
   reason). Bash effects declared unrestorable by construction. None of
   this exists in dsc.
4. Cache-break attribution. A StreamFunc middleware reconstructs the
   expected prefix (prompt N = prompt N-1 + appends), reports the FIRST
   differing component in wire order (system -> tools -> messages), and
   has an ExpectBreak channel so compaction reads as sanctioned. dsc has
   a prefix-stability unit test but zero runtime observation. This was
   in dsc's own DESIGN borrow table ("cache-stats.ts, vendor") and never
   got built.
5. Project context. DEEPSEEK.md > AGENTS.md > CLAUDE.md per directory,
   walked root-down, stops at .git boundaries, 32 KiB cap per file. dsc
   reads NO project instructions at all — every dsc run is blind to the
   repo's own conventions.
6. Skills with progressive disclosure (index in prefix, body on invoke),
   hand-rolled frontmatter parser with block-scalar support. dsc: none
   (build order #7, not started).
7. Parent-session budgets. MaxCost is cumulative including children and
   read through the same function /status prints (enforced == reported);
   MaxTurns bounds ONE request, not the session ("a 40-turn request is
   looping; a 40-question session is working"); begin() refuses to start
   a request already over budget. dsc budgets children only.
8. Parallel tool batches. Mode selection (one sequential tool forces the
   batch sequential), end-events completion-order, result messages
   source-order, per-file mutation locks. dsc is sequential-only — by
   Round 4 decision (adopt only on an eval win), so a deliberate
   deferral, not a miss.
9. Thinking/effort control. `thinking: {enabled|disabled}` +
   `output_config.effort`, degraded when the model lacks the effort;
   empty-thinking-block replay handled via pointer fields (DeepSeek
   emits signature-only thinking blocks; dropping the empty `thinking`
   field via omitempty fails the replay — JS object spread is immune to
   this by construction, which is why dsc never hit it). dsc sends no
   thinking config and exposes no effort knob.
10. Wire-payload hardening dsc lacks: orphaned tool_use answered with a
    synthesized "No result provided" error result; consecutive
    tool-result messages collapsed into one user message; tool_result
    whose call is absent dropped. dsc guarantees pairing upstream by
    construction (interrupted batches still pair every call), and
    verified live that /anthropic accepts consecutive same-role
    messages — weaker wire-layer defense, currently covered by loop
    invariants.

## Where dsc is ahead (the Go sibling lacks these)

1. DSML healing. Leaked `<|DSML|>`/`<｜DSML｜>` tool-call envelopes in
   visible text are parsed back into tool calls and stripped, both pipe
   variants, string="false" JSON params. deepseek-pi has nothing — it
   picked /anthropic to avoid DSML and stopped there; dsc observed leaks
   on /anthropic anyway.
2. Repetition killers. Read-dedup (identical re-read returns an
   unchanged-stub; anchors cleared at compaction so post-compaction
   re-reads return real content) and doom-loop short-circuit (identical
   batch three consecutive turns), both append-only so the prefix cache
   survives.
3. Task pinning through compaction. The run's prompt is restated
   VERBATIM after every summary — found live when a twice-compacted
   agent ran `find . -iname '*task*'` hunting for its own task.
   deepseek-pi's compaction has no equivalent; summaries erode there
   too.
4. /seek — delegation driven from outside the model, with the measured
   honesty that motivates it: models never delegate-early on their own
   (0/3 with the tool AND a guideline saying to), and fan-out loses
   wall-clock unless the work is deep and independent. Planner refuses
   shallow splits; synthesis bans re-investigation (measured 9-turn
   re-read spiral without the ban). deepseek-pi has only the model-
   driven task tool — which dsc's evals say never fires unprompted.
5. Eval-published negative results. Interactive-mode-saves-tokens
   debunked (cache is server-side and cross-process), /seek slower than
   solo on both fixtures tried, sub-agent regime B 2.08x slower. The Go
   sibling's eval harness is solid (calibrated tolerances, medians,
   restore-canonical-tests) but its README claims are mostly untested
   capability descriptions by comparison.

## Confirmed-by-both wire facts (safe to rely on)

- input_tokens on /anthropic is the cache-MISS portion;
  cache_read_input_tokens must be added for true prompt size.
  cache_creation is always 0 (automatic caching, no write charge).
- 616k usable input on both models; 1M is advertised only.
- Thinking signature is the response id, arrives via signature_delta,
  must replay verbatim.
- Retry-After beyond 60s: fail fast, never park the session.

## Port list for dsc, ranked

1. Project context discovery (~150 lines + tests). Biggest capability
   per line anywhere on this list; the epoch design in DESIGN.md already
   sanctions it (static per session start = epoch baseline). Port the
   .git-boundary walk, the 32 KiB cap, and root-down ordering.
2. Cache-break attribution (~200 lines). Already promised in the DESIGN
   borrow table. Port the expected-prefix model, first-differing-
   component attribution, ExpectBreak for compaction. Surfaces in
   /status and -p json.
3. Scheduler-scoped tool presets + bash classification (partial port of
   permission.go's classifyBash, ~150 lines). Not the full interactive
   ask-chain — just enough that unattended scheduled runs default to a
   read-only toolset with classified bash, per the decision-file safety
   model M7 documents. Fragments-before-splitting, every segment leads
   with an allowlisted program, unknown means unsafe.
4. Parent budget envelope semantics (~80 lines): MaxCost cumulative
   including children, refuse-to-begin when over, stop at the seam with
   at most one turn of overshoot. The scheduler needs per-job cost caps
   anyway; use the same shape.
5. Steering via the TurnSeam (later, with the durable inbox). The seam
   is already the sanctioned insertion point; do it when session_input
   lands, not before.
6. NOT checkpointing/rewind for now. It is the most craft-heavy
   subsystem in the sibling and the honesty rules are subtle; porting it
   badly is worse than not having it. Revisit after the scheduler
   milestone when unattended runs make "what did the agent change"
   urgent.
7. NOT full interactive permissions yet. dsc's positioning is headless/
   eval-first; the ask-chain earns its complexity when dsc has real
   interactive users. Scoped presets (#3) cover the scheduler.

## Stale-doc notes found in the sibling (FYI, not ours to fix here)

- README says "five tools" in one place, "4-schema tool set" in another,
  bash.go says 7; actual: parent 5, child 4.
- AfterToolResult doc claims nil-keeps-value for all fields; Details
  cannot be cleared once non-nil.
