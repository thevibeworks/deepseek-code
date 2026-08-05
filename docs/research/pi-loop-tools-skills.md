# pi-mono + oh-my-pi loop/tools/skills — raw deep-dive notes (2026-08-03)

Source: reference/pi-mono (P/) + reference/oh-my-pi (O/), both MIT.
Raw material for devlog synthesis; this is the M1 vendoring blueprint.

## 1. Agent loop (P/packages/agent/src/agent-loop.ts, 793 ln)

- agentLoop(prompts, context, config, signal, streamFn) and
  agentLoopContinue(context,...) return EventStream<AgentEvent,
  AgentMessage[]> — terminates on agent_end, final value = new messages.
  agentLoopContinue is the retry primitive (requires non-assistant tail).
- Structure (runLoop :155-275): OUTER loop while follow-ups exist; INNER
  while (hasMoreToolCalls || pendingMessages). Per iteration: turn_start
  → inject pending steering msgs → streamAssistantResponse → if
  stopReason error/aborted: turn_end + agent_end return → execute tools
  → append results → turn_end → prepareNextTurn hook (may swap
  context/model/thinkingLevel) → shouldStopAfterTurn → poll steering.
  Steering also polled ONCE at loop start.
- Events: agent_start/end, turn_start/end, message_start/update/end,
  tool_execution_start/update/end. A turn = one assistant response +
  its tool batch.
- StreamFn contract (types.ts:22-32): must NEVER throw; failures are a
  final AssistantMessage with stopReason error|aborted + errorMessage.
  Partial assistant message is REPLACED in-place at messages[len-1] on
  every delta — context always holds the live partial.
- stopReason=="length" + tool calls: ALL tool calls failed via
  failToolCallsFromTruncatedMessage (:381-406) — salvage-parsed args can
  validate while truncated. Error result says re-issue with complete
  arguments; terminate:false so the model retries. length with zero
  tool calls just ends the run.
- Tool pipeline: default parallel, but ANY tool in batch with
  executionMode "sequential" forces whole batch sequential (:419-422).
  prepareToolCall: lookup → tool.prepareArguments compat shim →
  typebox validation (WeakMap-cached compilers) → beforeToolCall can
  {block, reason}. Tools THROW on failure. afterToolCall can override
  result field-by-field. Early termination only when EVERY result sets
  terminate:true.
- ORDERING CONTRACT (copy verbatim): tool_execution_end fires in
  completion order; tool-result MESSAGES appended in assistant source
  order (:489-554).
- Steering/follow-up queues (agent.ts): PendingMessageQueue with
  QueueMode "all"|"one-at-a-time" (default one-at-a-time both).
  Agent.prompt() THROWS if run active — mid-run input must use
  steer/followUp. continue() drains steering first, then follow-up;
  skipInitialSteeringPoll avoids double-drain.
- Run failure synthesizes a full well-formed event sequence
  (message_start/end, turn_end, agent_end) — consumers never see a
  broken stream.
- TWO retry layers, both OUTSIDE the loop:
  1. Transport (P/packages/ai/src/utils/provider-retry.ts): SDKs called
     with maxRetries 0; own policy 408/409/429/5xx + x-should-retry,
     honors retry-after capped 60s (longer THROWS), exp backoff
     min(0.5*2^n, 8)s + jitter. Default 0 retries.
  2. Session (agent-session.ts:1075-1103): after run, if last assistant
     matches isRetryableAssistantError (curated regex + quota/billing
     blocklist), pop errored message from agent state (kept in session
     history), sleep 2s*2^n abortably, agent.continue(). Default 3
     attempts. Driver: while (await _handlePostAgentRun()) await
     agent.continue().
- transform-messages.ts:158-222 DROPS errored/aborted assistant messages
  from the provider payload and synthesizes "No result provided" tool
  results for orphaned calls — crashed turns never poison replay.

## 2. Tools (P/packages/coding-agent/src/core/tools/)

Shared: DEFAULT_MAX_LINES 2000, DEFAULT_MAX_BYTES 50KB,
GREP_MAX_LINE_LENGTH 500 (truncate.ts:11-13). Two independent limits,
whichever first; never partial lines. All tools have pluggable
Operations interfaces for SSH/remote.

- read: offset/limit 1-indexed; ACTIONABLE continuation notices
  ("[Showing lines X-Y of Z. Use offset=N to continue.]"); >50KB single
  line gets a bash sed fallback hint; images auto-resized 2000x2000.
  Limits baked into description text.
- bash: timeout in SECONDS, no default; spawn detached, command via
  STDIN (commandTransport), abort/timeout kill process TREE; exposes
  PI_SESSION_ID/PI_MODEL etc env; NO background mode in pi-mono
  (oh-my-pi adds managed async jobs, PTY, auto-backgrounding, and a
  bash-interceptor rerouting cat/rg/sed -i to read/grep/edit).
  OutputAccumulator: rolling tail 2x maxBytes in memory, temp-file
  spill the moment output exceeds limits, replaying buffered chunks
  (${tmpdir}/pi-bash-<16hex>.log). Footers give full-output path.
  Nonzero exit/timeout/abort THROW with output attached.
  Updates throttled 100ms.
- edit: MULTI-EDIT native ({path, edits:[{oldText,newText}]});
  prepareArguments heals edits-as-JSON-string + legacy single-edit
  args. Matching = exact indexOf FIRST, then fuzzy in normalized space
  (NFKC, per-line trailing-ws strip, smart quotes→ASCII, unicode
  dashes→-, exotic spaces→space); BOM stripped, CRLF normalized and
  restored on write. All edits match ORIGINAL content, applied reverse
  offset order; overlaps throw. Fuzzy overlay preserves untouched
  lines' exact bytes. Pedagogical failure strings (not-found /
  ambiguity-with-count / no-op). Per-file async mutation queue keyed on
  realpath; abort only observed between awaits. Guidelines push
  batching + minimal-unique oldText.
  oh-my-pi diverges: default edit = "hashline" line-anchored patch
  language with 4-hex content-hash tags + SWAP/CUT/INS/PASTE +
  tree-sitter ops (O/packages/hashline) — relevant if v4 arg fidelity
  makes exact-string editing flaky; they built
  typescript-edit-benchmark to decide.
- write: unconditional overwrite, mkdir -p, same mutation queue.
- grep: ripgrep --json (auto-downloaded via ensureTool), 100 matches /
  500-char lines / 50KB; details record what was cut.
- find: fd, 1000 results/50KB; ls: 500 entries/50KB, retry hint with
  exact limit=N.
- Tool→prompt integration: each ToolDefinition carries promptSnippet
  (Available-tools line) + promptGuidelines (merged into Guidelines
  section) — tool docs live WITH the tool, assembled deterministically.

## 3. Skills

pi-mono (core/skills.ts): discovery ~/.pi/agent/skills + .pi/skills +
configured; SKILL.md dir = skill root; frontmatter name/description
(REQUIRED)/disable-model-invocation; agentskills.io validation (name
<=64 [a-z0-9-], desc <=1024). Prompt = XML <available_skills> with
name/description/location ONLY — bodies never in prompt; instruction
"use read when task matches". Section only present if read tool active.

oh-my-pi (extensibility/skills.ts + docs/skills.md): provider-based
discovery with priority (native .omp 100 > omp-plugins 90 > claude 80 >
agents/codex 70 > opencode 55 > github 30 > managed auto-learn 5,
always defers to authored). Reads OTHER harnesses' skill dirs (.claude,
.codex, .gemini, .config/opencode). Deterministic sort for prompt
stability. Frontmatter adds globs/alwaysApply/hide. Invocation:
skill://<name>[/<path>] URL protocol with traversal validation +
listing on unknown; /skill:<name> slash + mid-prompt token form; two
injection templates (user-invocation vs autoload — autoload
deliberately does NOT claim user invocation); delivery queue chosen by
keybinding (Enter=steer, Ctrl+Enter=followUp). Subagents spawnable with
autoloadSkills (bodies as hidden messages). LLM-writable manage_skill
tool + managed-skills subsystem with sanitization (renders unescaped
into prompt).

## 4. Extensions/events (pi-mono)

- jiti-loaded TS modules with virtualModules so extensions import pi
  packages inside the compiled binary. Discovery .pi/extensions →
  ~/.pi/agent/extensions, one level deep.
- Events: lifecycle (session_* incl. cancellable before_
  switch/fork/compact/tree), before_provider_request/headers,
  after_provider_response, before_agent_start (inject message / replace
  system prompt for ONE turn, chained), full loop mirror, tool_call/
  tool_result (interceptive) vs tool_execution_* (observational),
  model_select, thinking_level_select, user_bash, input.
- CAN: block/mutate tool calls, rewrite results field-by-field, rewrite
  full LLM context (structuredClone'd first — safety over zero-copy,
  value-equal so cache unaffected), take over ! bash, register
  tools/commands/providers/renderers, steer/followUp, appendEntry
  custom state (NOT in LLM context), setActiveTools.
- CANNOT: alter core control flow beyond block/steer/stop; handler
  errors caught, never crash session; message replacement can't change
  role. Hooks installed ONCE reading current runner at call time.

## 5. Session format (tree JSONL, docs/session-format.md)

- ~/.pi/agent/sessions/--<cwd-dashes>--/<ts>_<uuid>.jsonl, v3.
- Entry: {type, id, parentId, timestamp}. IDs = 8-hex randomUUID slices
  w/ collision re-roll (uuidv7 is SESSION id only — SOURCES.md
  correction). Types: session header (parentSession for forks), message,
  model_change, thinking_level_change, compaction (summary +
  materialized retainedTail = self-contained checkpoint),
  branch_summary, custom (not in context), custom_message (in context),
  label, session_info.
- Branching IN-FILE: branch(entryId) moves leaf pointer; no new file.
  /fork = new file + parentSession pointer.
- Resume: walk leaf→root; if compaction on path, context = summary
  (+retainedTail) + everything after. Fixed prefix strings for
  synthesized messages so serialization is identical every turn.
- Lazy creation: nothing hits disk until first assistant message
  (buffer + "wx" flush); then appendFileSync per entry.

## 6. Prompt assembly + cache stability

Assembly order (system-prompt.ts:28-162), exact:
1. fixed role paragraph; 2. Available tools (only tools with
promptSnippet); 3. fixed custom-tools note; 4. Guidelines (deduped
per-tool promptGuidelines + 2 always-on); 5. pi self-doc block;
6. appendSystemPrompt; 7. <project_context> with each AGENTS.md/
CLAUDE.md in <project_instructions path=...> (global first, then
ancestor dirs ROOT-DOWN, first-match per dir, worktree dedup);
8. skills XML (if read active); 9. "Current working directory: <cwd>"
LAST — the only per-machine dynamic value. No date, no time, nothing
time-varying. Cached as _baseSystemPrompt; extension override scoped to
single run, cleared in finally.

Pass-by-reference chain (the byte-stability mechanism):
1. Run snapshot copies only the top-level ARRAY; element objects shared.
2. convertToLlm returns user/assistant/toolResult messages as THE SAME
   OBJECT REFERENCES; custom roles re-synthesized from pure functions
   of stored fields with fixed prefix constants — byte-identical.
3. transform-messages passes user messages by reference; same-model
   assistant content blocks by reference; rewriting only on cross-model
   replay (thinking→text, ID normalization).
4. Anthropic cache_control: LAST system block + LAST tool def + LAST
   user-ish message (classic 3-breakpoint layout).
Invariant enforced BY CONSTRUCTION (immutable history + deterministic
converters + static system prompt), not by a diffing layer. To preserve
when vendoring: never rebuild history per turn, never inject
time-varying content before the tail, route mid-session instruction
changes through appended messages.

## Corrections vs SOURCES.md

1. Edit is exact-THEN-fuzzy with normalization + byte-preserving
   overlay; pedagogical error strings.
2. Entry IDs are 8-hex slices, not uuidv7 (session id is uuidv7).
3. Session files lazily created (first assistant message).
4. TWO retry layers (transport default-0 + session 3x/2s classifier).
5. pi-mono bash has NO background mode; oh-my-pi added it.
6. Parallel tools: end-events completion-order, result messages
   source-order.
7. emitContext structuredClones when context handlers exist — safety
   over zero-copy, cache preserved via value equality.
8. oh-my-pi skills: skill:// protocol, hide/globs/alwaysApply,
   autoload-into-subagents, LLM-managed skills.
