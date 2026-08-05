# deepseek-code — design

Working title: deepseek-code. Binary: `dsc`. Status: draft v2 + Round 3/4
deltas, 2026-08-04 (v2 folds in the opencode/pi-mono/oh-my-pi survey — see
../SOURCES.md "Round 2"; deltas appended at the end of this file).

A DeepSeek-native coding agent for the v4 flash/pro GA series. Independent
TypeScript/Bun implementation. Proprietary harnesses studied for
BEHAVIOR only, never code (license);
pi-mono and opencode-v2 are MIT — we borrow their best code with
attribution; evot/reasonix/DeepSeek-TUI are pattern references.

## Assembly, not from-scratch (v2 revision)

The MIT surveys changed the economics. dsc is an assembly of proven parts
specialized for DeepSeek:

| Component | Source to borrow | Form |
|---|---|---|
| Agent loop | pi `packages/agent/src/agent-loop.ts` (steering, follow-up queue, length-poisoned tool-call fix) | contracts vendored; implementation our own (M1 shipped a ~225-line rewrite honoring them — do not "finish" vendoring the code) |
| Cache observability | pi `cache-stats.ts` (~160 lines, missed-token reconstruction) | vendor |
| Tool output bounding | pi `truncate.ts` (2000 ln/50 KB, spill + range report) + opencode single-choke-point registry | vendor + adapt |
| System-context epochs | opencode-v2 `system-context/` (Source/reconcile/replace, persisted baseline, mid-conversation system messages) | reimplement small |
| Durable inbox + events | opencode-v2 `session_input` (steer/queue, admitted/promoted seq) + two-stream SSE (durable ?after=seq + live-only) | reimplement small |
| Provider wire | own code, opencode `packages/llm` shape (protocol/route split, 5 deps); oh-my-pi docs as DeepSeek wire spec | write |
| Compaction | evot pipeline (reclaim -> plan -> summarize -> emergency) + opencode anchored-summary template | write |
| Sub-agent tool | opencode V1 `task.ts` patterns (task_id resume, depth bound, background + anti-polling prose) + our role presets | write |
| TUI | pi-tui (`@earendil-works/pi-tui`, standalone, 2 deps, no native code) | dependency |
| Session format | pi tree-JSONL ideas + SQLite storage (below) | own |

## Thesis

DeepSeek's economics make the harness the product. Flash is cheap enough
to run enormous iterative loops IF the harness preserves the automatic
prefix cache, keeps context small and high-quality, and escalates to pro
only where judgment is needed. Every design decision below serves one of
four pillars (the product requirements):

1. proactive agent — monitoring and scheduled work built in, not bolted on
2. thinking + good tool/skill use — tuned to how v4 actually behaves
3. sub-agents and agentic teams
4. token efficiency — measured, not vibed

## Non-goals (v1)

- Not multi-provider-first. DeepSeek is the design center; OpenAI-compat
  endpoints work but never drive design.
- No IDE extension, no desktop app. Terminal + headless + HTTP serve.
- No sandbox implementation in v1 (permission prompts + workspace scoping
  first; Landlock/Docker sandbox is v2).
- No extension/plugin system in v1. The durable event log (which must
  project onto ACP anyway) IS the extension surface; pi's jiti extension
  layer is its most bloat-prone subsystem and we do not import it.
- Not a Claude Code clone. We port *decisions*, not surface area.

## Runtime and shape

- Bun + TypeScript, single package, no engine/TUI split (evot's Rust/NAPI
  split buys microseconds we don't need; Bun compiles to a single binary
  via `bun build --compile`, which recovers Go's distribution story).
- One transport-agnostic core (reasonix's `control.Controller` lesson):
  `Session` + `Engine` behind three frontends: TUI (interactive), `-p`
  (headless print), `dsc serve` (HTTP + scheduler daemon). Behavior lives
  in the core so all frontends inherit it.
- One API definition, two hostings (opencode's embedded-mode shape): the
  TUI and `-p` run the same routes in-process with no listener; `serve`
  binds them to HTTP+SSE. No "local fast path" to drift. Local server
  requires a token by default (opencode ships unauthenticated; we don't).
- TUI stack: pi-tui — standalone MIT, two deps, differential rendering,
  no React/no native code. opentui (Zig FFI) rejected for v1 on
  portability evidence; revisit if we outgrow pi-tui.
- Layout:

```
src/
  provider/      wire protocols + model catalog
  engine/        agent loop, context engine, compaction, budgets
  tools/         tool implementations + schemas + coercion
  session/       storage (JSONL), resume, forking
  scheduler/     task ledger, cron, watchers, notifications  [pillar 1]
  skills/        SKILL.md discovery + progressive disclosure
  team/          sub-agent spawn/roles/budgets               [pillar 3]
  tui/           terminal frontend
  serve/         HTTP/SSE frontend + dashboard (trace viewer)
eval/            harness lives with the code it gates (see EVAL.md)
```

## Provider layer (pillar 2)

- Own the wire format, zero vendor SDKs (opencode's `packages/llm` proof:
  every provider on 5 deps; its V1 hauled 20 @ai-sdk/* packages for the
  same job). Shape: protocol (wire + stream state machine) x route
  (baseURL/auth) — DeepSeek native and `/anthropic` are two routes over
  two protocols, each a few hundred lines we control.
- One protocol first-class: Anthropic-compatible `/anthropic`. The
  DeepSeek OpenAI-style route is a fallback we build only when something
  forces it (Round 4) — one stream state machine to keep correct. We
  have hard evidence it carries tool use, parallel tool calls, thinking
  blocks, and cache-read reporting correctly (bench/README.md), and
  oh-my-pi's wire docs explain WHY: v4 emits DSML, an Anthropic-shaped
  invoke/parameter tool grammar. The model is trained toward this shape.
- DeepSeek wire hardening (from oh-my-pi docs/toolconv + endpoint
  constraints; these are requirements, not nice-to-haves):
  - DSML healing in the stream decoder: hosts (incl. DeepSeek's own
    OpenAI-compat API) leak `<|DSML|...>` tool-call envelopes into
    visible content; parse them back into tool calls, strip from text,
    buffer across chunk boundaries (markers split mid-token).
  - Exact `reasoning_content` replay on assistant turns (no synthetic
    placeholders) on the native protocol.
  - `tool_choice` may be rejected while thinking is enabled — degrade
    per policy (disable reasoning for forced tool choice).
  - Native usage: `prompt_cache_miss_tokens` is billed input, not a
    cache-write charge; account accordingly.
- Model catalog with REAL numbers (evot's lesson): v4 flash/pro = 616k
  usable input / 1M advertised / 384k output; effort levels
  off|low|high|xhigh|max; budget math always uses 616k.
- Flash-first, pro-escalation: flash is the default executor; `--model`
  pins. A session transcript is pinned to ONE model (Round 4 rule); the
  `/pro` escalation mechanism — same-transcript switch vs
  evidence-packet handoff — is an open question, eval-gated at M4.
- Usage accounting from provider `usage` only; cost computed from our own
  pricing table (retargeted Claude harnesses misprice DeepSeek ~13x —
  never trust harness
  cost fields, ours included: recompute in eval).

## Context engine (pillar 4) — the evot playbook, ported

Priority-ordered; each lands only with an eval win (see Process):

1. Context epochs (opencode-v2 design, strictly better than a boundary
   sentinel alone). The baseline system context (identity + tools +
   guidelines + project instructions + skill index) is rendered ONCE per
   epoch, persisted verbatim in storage, and replayed byte-identically
   every turn. When inputs change mid-session (AGENTS.md edited, skills
   added, date rolls), the baseline is NOT re-rendered — a single
   chronological system message carrying the complete new state is
   appended at the next safe turn boundary. Prefix survives; cache
   survives. Transient read failures preserve the last value
   (unavailable != absent); only confirmed absence emits removal text.
   A new epoch starts only at compaction.
2. Append-only messages, pass-through by reference (pi's convertToLlm
   lesson: serialization must never clone-and-mutate earlier messages).
   Compaction is the single sanctioned prefix break, and it's budgeted:
   post-compaction envelope ~40k, retained tail = budget MINUS
   system+tools overhead.
3. Reclaim before summarize. Tool results tagged current-run are cleared
   losslessly when their run ends. Zero model calls.
4. Spill, don't truncate. Tool results > 100 KB go to disk; 4 KB preview
   + "Read with offset/limit". Model re-reads on demand.
5. Repetition killers: read-dedup (identical re-read returns an
   unchanged-stub) and doom-loop skip (identical tool batch across
   consecutive turns short-circuits).
6. Two-tier token accounting: provider usage anchors, len/4 estimates
   only the trailing delta. No tokenizer dependency.
7. Compaction with cross-state: deterministic emergency summary always
   available; LLM summary (flash) updates the previous summary instead
   of restarting; file-ops/env-discoveries/decisions survive as
   structured state in the transcript.

## Tools (pillar 2)

Small and stable — the schema is part of the cached prefix:

- Core: `read`, `bash`, `edit`, `write`, `fetch`, `task` (sub-agent),
  `ask_user` (TUI only). bash absorbs grep/glob/find/ls; the prompt says
  so. Target: 7 schemas, not 40.
- Modes change *permissions*, not schemas (cache-stable): plan mode keeps
  edit/write registered but disallowed with a clear refusal string.
- Tool-input coercion, not retries: alias normalization (file_path/
  filename/path), string-wrapped-JSON unwrapping, single structured
  error listing every problem at once. Every failed call is wasted
  tokens AND a cache-unfriendly retry turn.
- Tool results capped (100 KB hard, 50 KB per tool default, bash
  tail-2000-lines) with head+tail truncation, long-line clipping.
- MCP is OUT of core (Round 3 amendment governs): if it ever ships it is
  an extension-tier feature behind the same tool interface, never a core
  dependency.

## Skills

- Discovery: `./.agents/skills/`, `~/.agents/skills/` (cross-client
  convention), plus `./.dsc/skills/`, `~/.dsc/skills/`.
- SKILL.md with frontmatter; progressive disclosure (index line in
  prompt, body loaded on invoke) — skill bodies never sit in the stable
  prefix, only the one-line index does (prefix stays small AND stable).
- v2: skill versioning + per-skill eval records (the "skills with
  evidence" idea from the research docs).

## Sub-agents and teams (pillar 3)

- `task` tool: spawn/wait/result/cancel lifecycle (DeepSeek-TUI shape),
  parallel by default, results return as compressed reports.
- Roles as prompt+permission presets: explorer (read-only, flash),
  implementer (write, flash), reviewer (read-only, pro), tester (bash,
  flash). Verified pattern: bounded sub-contexts beat one giant context.
- Every sub-agent gets a budget envelope: max tokens, max turns, max
  wall-clock. A looping child dies quietly; the parent gets a partial
  report. (Capability-token idea from research, minimum viable form.)
- Sub-agent transcripts are separate sessions on disk — inspectable,
  resumable, and excluded from the parent's context except the report.

## Proactive agent (pillar 1) — the differentiator

No competitor has this built-in; we run it in production already (the
deepseek-docs sync agent) and port the pattern inward:

- `dsc serve` = scheduler daemon + HTTP/SSE. Task ledger (JSONL) holds:
  cron tasks (schedule + prompt + workdir + budget), watch tasks
  (file-glob or command-predicate triggers), and one-shot deferred tasks.
- Each firing runs a headless session with a hard budget envelope;
  results append to the ledger; notification hooks (command/webhook)
  fire on completion or on signal.
- The agent-decides / deterministic-publisher split is the safety model:
  scheduled agents write decision files; side effects (commit, push, PR,
  deploy) run in deterministic scripts that consume them. This is a
  documented pattern + template, enforced by the default permission
  preset for scheduled runs (no push/PR perms for the agent itself).
- TUI surfaces the ledger: `dsc ps` (running/scheduled), `/monitor` to
  create a watch from inside a session.

## Sessions, memory, observability

- Storage: SQLite via `bun:sqlite` (zero deps). Tables: session,
  session_message (unique(session_id, seq)), session_input (the durable
  inbox: delivery steer|queue, admitted_seq, promoted_seq),
  session_context_epoch (persisted baseline + per-source snapshot),
  event (aggregate_id, seq — durable, replayable with ?after cursor).
  The inbox + event log are what make the scheduler (pillar 1) and
  mid-turn steering safe and replayable; JSONL alone can't give us
  cursor replay. `dsc export` emits pi-compatible tree JSONL for
  interop/grepability.
- Compaction shrinks the *context view*, never storage. Fork = new
  session referencing parent seq.
- Resume: by id, or semantic (`dsc -r "the slugify fix"`) via one cheap
  flash ranking call over recent session excerpts (evot's rank_sessions).
- Memory: project `DSC.md` (+ `AGENTS.md`/`CLAUDE.md` read-compat) in the
  stable prefix; memory vault for clips/facts out of prefix.
- Every LLM call persists: system-prompt tokens, tool-def tokens,
  per-tool context consumption, cache hit/miss, effort, model. "What is
  eating my context" and "what broke my cache" are first-class queries
  (`/status`, serve dashboard span traces). Cache-break detection à la
  cache-break detection as seen in mainstream harnesses, adapted to
  DeepSeek's
  cache_read-only reporting.

## Process rules (adopted from reasonix + evot)

- Cache-impact discipline: PRs touching prompt/tools/provider paths must
  state `Cache-impact:` + a guard test. A prefix-stability unit test
  (byte-compare across two synthetic turns) runs in CI from day one.
- Eval-gated engine changes: token usage, cost, success rate on the
  benchmark suite must improve or hold. Numbers decide what stays.
- No speculative config. Every option must have a user who needed it.
- Anti-bloat guardrails (opencode V1 is the cautionary tale — 175k-LoC
  legacy engine, 99 deps, 3,221-package lockfile, 9-month dual-engine
  rewrite): no per-provider vendor SDKs, ever; no LSP/ACP/IDE runtime in
  the agent process; no committed generated SDKs; dependency budget
  enforced in CI (core: <= 10 runtime deps); one engine — if we rewrite,
  we replace, not run two.

## Naming

`deepseek-code` reads as official DeepSeek, which we are not. Options:
keep as working title and rename before publish; the `dsc` binary is
neutral. Avoid `dscode` (taken: thinkany-ai/dscode and dipankar/dscode).
Decision deferred to publish time; nothing in the code should hardcode
the product name (single constants module — a lesson from harnesses
that scattered it,
done right).

## Build order (v1 milestones)

1. Provider + engine core: Anthropic-protocol client, catalog, loop,
   4 tools (read/bash/edit/write), headless `-p` mode. Exit: passes the
   bench-task1 bug-fix eval at cost <= the private comparison baseline.
2. Context engine: boundary sentinel, reclaim, spill, caps, coercion,
   accounting. Exit: measurable token reduction vs milestone 1 on the
   eval suite; prefix-stability test green.
3. Sessions + resume + compaction. Exit: long-task eval survives
   compaction with correct continuation.
4. Sub-agents (task tool + roles + budgets). Exit: parallel exploration
   eval beats single-agent on wall-clock at comparable cost.
5. TUI (minimal: input, stream render, /status, /pro, modes).
   SHIPPED, re-cut: the missing capability was a conversation, not a
   canvas, so this landed as a line-based interactive mode with no TUI
   dependency (pi-tui not adopted; see
   docs/devlog/2026-08-05-m5-interactive.org). /pro still open.
   `/seek` (parallel investigation) landed on top of it as the explicit
   delegation mode M4 asked for — see docs/devlog/2026-08-05-m6-seek.org,
   including the measurement that it costs wall-clock rather than saving
   it.
6. Scheduler (`dsc serve`, cron + watch, decision-file pattern, ps).
7. Skills + MCP client.

Eval harness (EVAL.md, separate task) develops in parallel from milestone
1 — it gates every milestone exit.

## Round 3 deltas (2026-08-03)

Implementation-depth dives (docs/research/, synthesis in
docs/devlog/2026-08-03-learning-round-3.org) change the following.
Everything else in this document stands.

1. ACP as an M1 SHAPE constraint. The durable event log remains the
   internal source of truth; its event vocabulary must project cleanly
   onto ACP session/update shapes (agent_message_chunk, tool_call,
   tool_call_update, thought_chunk) so a thin adapter (initialize,
   session/new, session/prompt, session/cancel + notifications) can be
   added at M5. goose proves an entire product surface rides on ACP.
   We do NOT adopt ACP as the internal model.
2. Vendor pi loop contracts verbatim: stopReason=length fails all tool
   calls in the batch; tool end-events completion-order but result
   messages source-order; StreamFn never throws; two retry layers
   outside the loop (transport policy + session-level classifier);
   crashed turns scrubbed from provider payloads with synthesized
   error tool results.
3. Inbox = projection of the event log (opencode v2 finding):
   admitted_seq/promoted_seq ARE durable event seqs; unique
   (session_id, promoted_seq) gives exactly-once promotion. One
   substrate; drop the separate-queue framing from the storage section.
4. Edit tool: pi's exact-then-fuzzy matching (NFKC/quote/dash
   normalization, byte-preserving overlay, pedagogical error strings),
   multi-edit-native schema with arg-healing. oh-my-pi's hashline
   patch language stays a measured fallback — adopt only if the eval
   shows v4 arg-fidelity problems with string matching.
5. Sub-agents (M3): recursion prevention is structural — subagent tool
   pools exclude the task tool; no depth counters. model:"inherit"
   resolves to the parent's exact model string. Design informed by
   patterns + opencode V1 task tool; opencode v2 has no task tool to
   port. Compaction/title/summary run as hidden agents.
6. Scheduler (M4) hard requirements from goose's trap list: atomic
   tmp+rename job-ledger writes; flush running-state transitions
   (session id visible mid-run); per-job cwd; run-now returns a
   session id immediately (async), never blocks the RPC; cron
   validated at add time by the same parser that fires it; jobs fire
   only in the long-lived `dsc serve` process (CLI verbs only edit
   the ledger).
7. Compaction details locked: visibility-flags over deletion (goose),
   usage-anchored token counting (provider-reported first), summary
   produced by the flash tier as a hidden agent sharing the parent
   prompt-cache prefix (fork trick), frozen-decision
   tool-result budget (replaced ids re-apply byte-identical strings;
   kept ids never replaced later), single-shot mid-run overflow
   recovery, and: resume must zero usage on preserved assistant
   messages or autocompact re-triggers instantly.
8. Uniform injection principle, stated as a rule: everything
   mid-session (skills, hook output, scheduler notifications,
   instruction changes) enters as appended messages or epoch
   boundaries — never prompt mutation. Cache-break detection that
   attributes which axis changed (system/tools/messages) ships with
   the CI byte-compare test.

Amendment to "Build order": milestone 7 "Skills + MCP client" — MCP
remains OUT of core (goose keeps core tools in-process too); if MCP
ever ships it is an extension-tier feature behind the same tool
interface, not a core dependency. Milestone 1 exit gate is now
concrete: eval/BASELINE.md (dsc/flash, pinned).

## Round 4 deltas (2026-08-04)

Post-M1 design review against the pi research (devlog
2026-08-04-design-review-pi-round-4.org). Body fixes applied in place
(loop table wording, single first-class protocol, MCP line, extension
non-goal, /pro line). New rules and open questions:

1. Model-pinned transcripts. A session transcript is pinned to one
   model; crossing models means a new context. This deletes pi's
   entire cross-model replay layer (thinking→text rewrites, ID
   normalization) from our scope — the concrete win of being
   DeepSeek-only. Nobody has verified /anthropic accepts
   flash-generated thinking blocks replayed under pro; do not assume
   it.
2. /pro mechanism is OPEN, eval-gated at M4. Candidates:
   (a) same-transcript switch — simple, costs a full-prefix cache
   miss repriced at pro input (~$0.04 per escalation at 100k ctx) and
   depends on the unverified replay semantic above; (b) evidence
   packet into a fresh pro context — sidesteps both, and the M4
   pro-reviewer sub-agent makes it nearly free. Decide with an eval,
   not by taste.
3. Tool docs live with the tool. ToolDefinition carries promptSnippet
   + promptGuidelines; the system prompt's tool lines and guidelines
   are assembled deterministically from them (pi pattern). Adopt
   BEFORE the tool set grows past the current four — retrofitting
   after `fetch`/`task`/`ask_user` exist is where drift starts.
4. Named between-turns seam in the engine (pi prepareNextTurn +
   shouldStopAfterTurn equivalents). Everything that acts "between
   turns" — autocompact trigger, budget envelopes, steering
   injection, model arming — inserts here instead of being inlined
   into the loop body. This is the one Round 4 item M2 directly
   depends on; name it before writing reclaim/compaction logic.
5. Tool-batch execution policy: stay sequential through M2; adopt
   pi's parallel contract (parallel default; any sequential-mode tool
   forces the whole batch sequential; end-events completion-order,
   result messages source-order) as an M3 target only if an eval
   shows the wall-clock win. The per-file mutation queue (realpath-
   keyed) ships together with parallel batches — required under
   them, dead weight before.
6. Bash spill adopts pi's OutputAccumulator shape in M2: rolling
   tail in memory, temp-file spill the moment limits are exceeded
   during streaming, footer with the full-output path. "Spill, don't
   truncate" must be true for the tool that produces most oversized
   output, not just for stored results.
7. Canonical upstream moved: pi lives at earendil-works/pi
   (badlogic/pi-mono redirects; reference/pi is the fresh clone,
   reference/pi-mono is stale — research docs cite its paths but all
   new dives use reference/pi). New upstream packages: protocol,
   server, storage, client, evals. Skim packages/evals before
   extending eval/ — steal shapes if they fit. Ecosystem index:
   thevibeworks/awesome-pi-agent (131 verified repos; mining targets
   for M4: nicobailon/pi-subagents, pi-boomerang, pi-mcp-adapter,
   earendil-works/pi-review-loop).
