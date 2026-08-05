# opencode v2 engine — raw deep-dive notes (2026-08-03)

Source: reference/opencode (MIT). Paths relative to reference/opencode/.
Raw material for devlog synthesis. Engine = packages/core (Effect-TS,
drizzle/SQLite) + packages/{server,protocol,schema,llm,sdk-next};
packages/opencode/src is V1 (still hosts CLI, task tool, MCP, LSP).

## 1. Provider layer (protocol x route split) — packages/llm

5 runtime deps: effect, @opencode-ai/schema, @smithy/eventstream-codec,
@smithy/util-utf8, aws4fetch.

- Protocol<Body, Frame, Event, State> (route/protocol.ts:36-63):
  { id, body: {schema, from(LLMRequest)}, stream: {event codec,
  initial(request)=>State, step(state,event)=>[State, LLMEvent[]],
  terminal?, onHalt?} }. Doc comment: "A Protocol is NOT a deployment...
  DeepSeek, TogetherAI, Cerebras all reuse OpenAIChat.protocol without
  forking 300 lines per provider."
- Endpoint (route/endpoint.ts:22-26): baseURL + path (string or fn of
  body — Bedrock/Gemini model-in-URL) + query.
- Auth combinators (route/auth.ts): Credential.load => Redacted;
  Auth.value/config/optional/effect/bearer/header/bearerHeader/custom.
- Route.make = 4-axis constructor: protocol + endpoint + auth + framing
  (route/client.ts:303-339); route.with(patch) immutable rebuild;
  route.model({id, provider}) mints a Model bound to configured route.
- compile (route/client.ts:344-359): cache policy → body.from →
  schema-validate → prepare transport.
- Protocols: openai-chat (506 ln), openai-compatible-chat (reuses
  OpenAIChat.protocol + /chat/completions + SSE framing — the split
  proven), openai-responses, anthropic-messages (855 ln), gemini,
  bedrock-converse(+binary event-stream framing).
- deepseek EXISTS as a profile: openai-compatible-profile.ts:10
  { provider:"deepseek", baseURL:"https://api.deepseek.com/v1" }.

NUANCE vs SOURCES.md: the core agent loop does NOT consume those
facades. runner/model.ts:142-170 maps catalog api.package to exactly 3
routes: @ai-sdk/openai → OpenAIResponses, @ai-sdk/anthropic →
AnthropicMessages, @ai-sdk/openai-compatible+url → OpenAICompatibleChat;
else UnsupportedApiError. "DeepSeek = 1 line" holds only through the
catalog with openai-compatible; DeepSeek wire quirks (reasoning_content
replay, DSML healing) would need a new Protocol or additions to the
openai-chat stream state machine.

Catalog: models-dev.ts fetches models.opencode.ai/api.json, 5-min TTL
cache + cross-process flock, 60-min background refresh, compile-time
snapshot fallback. ModelV2.Info: capabilities, cost array WITH TIERS
(incl. context_over_200k), limit, variants, status.

## 2. System-context epochs — EXACT interfaces

Source<A> (system-context/index.ts:32-39):
- key (branded, /^[a-z0-9][a-z0-9._-]*\/.../), codec (Schema.Codec<A,
  Json>), load: Effect<A | Unavailable>, baseline(current)=>string,
  update(previous,current)=>string, removed?(previous)=>string.
- unavailable = Symbol.for("@opencode/SystemContext.Unavailable") —
  "could not be observed without treating it as removed".
- make() erases A; compare(previousJson) decode-fail = Incompatible;
  Schema.toEquivalence decides Unchanged/Updated.
- SourceSnapshot = {value: Json, removed?: text} — removal TEXT is
  precomputed and persisted so a source that later disappears from the
  registry can still render its removal message.
- initialize: ANY unavailable source => InitializationBlocked (an epoch
  never starts incomplete). Baseline = all baseline() texts joined \n\n.
- reconcile: Unavailable+stored → carry forward, emit NOTHING (the
  unavailable-vs-absent distinction, :251-253); new source → baseline
  text as update; changed → update(prev,cur); removed-with-renderer →
  stored removed text; removed-without-renderer OR codec-incompatible →
  force Replace.

Persistence: session_context_epoch (session/sql.ts:168-176):
session_id PK, baseline (FULL rendered text), snapshot json,
baseline_seq. ONE row per session — replace in place, not a history
table. Baseline replayed VERBATIM from the stored row, never
re-rendered.

Epoch driver (session/context-epoch.ts):
- initialize on first turn; baseline_seq = latest event seq.
- prepare at every turn start: if a compaction is newer than baseline →
  SystemContext.replace — NEW EPOCH IS CUT AT COMPACTION (:59-62).
  Otherwise reconcile; Updated → durable SessionEvent.ContextUpdated
  whose snapshot-advance commits ATOMICALLY in the same SQLite tx as
  the event append (EventV2 commit hook).
- Consumption: request system = [agent.system, epoch.baseline].
  ContextUpdated projects to a session_message type "system", lowered
  chronologically mid-conversation. History excludes system messages
  with seq <= baseline_seq (superseded) but keeps later ones across the
  compaction cut (session/history.ts:33-47).
- Built-in sources: core/environment, core/date, core/instructions
  (AGENTS.md walk; read-failure → unavailable; update text "These
  instructions replace all previously loaded ambient instructions."),
  core/skill-guidance (available-skills XML, agent-scoped).

Epoch-cut triggers, complete list: first turn; compaction newer than
baseline; codec-incompatible snapshot; source removed without a removal
renderer.

## 3. Session inbox + event streams

session_input (session/sql.ts:140-166): id PK, session_id FK, prompt
json, delivery steer|queue, admitted_seq NOT NULL, promoted_seq
nullable; UNIQUE(session_id, admitted_seq), UNIQUE(session_id,
promoted_seq) — exactly-once promotion.

State machine (session/input.ts):
1. admit() idempotent by message id; durable PromptAdmitted (event seq
   BECOMES admitted_seq). Projects NO message.
2. pending = promoted_seq IS NULL.
3. promote only in the runner at a turn boundary (runner/llm.ts:187-195):
   cutoff = latestSequence; promoteSteers publishes durable Prompted for
   all pending steers <= cutoff; promoteNextQueued promotes exactly ONE
   queued item (then drains steers). Prompted projection sets
   promoted_seq AND appends the user session_message.
4. POST /api/session/:id/prompt {prompt, delivery?, resume?} → admit +
   execution.wake unless resume===false. SessionRunCoordinator
   serializes per-session drains with coalesced wake.
   STEER = merged into in-flight run at next turn boundary;
   QUEUE = next run.

KEY INSIGHT vs SOURCES.md: admitted/promoted seqs ARE durable event
seqs — the inbox table is a projection of the event stream with
atomic commit, not an independent queue.

Event store (event/sql.ts): event_sequence(aggregate_id PK, seq,
owner_id); event(id, aggregate_id, seq, type, data) UNIQUE(aggregate_id,
seq). EventV2.publish → ONE immediate SQLite tx: read seq → run
projectors → optional commit(seq) hook → upsert sequence → insert
event. Idempotent replay w/ divergence detection; owner claiming for
sync. After commit: wake per-aggregate durable subscribers + live
pubsub.

Two streams:
- Per-session durable SSE GET /api/session/:id/event?after=N — replay
  rows seq>after then wake-driven re-reads (no gap between replay and
  live). Paged twin /history?after&limit<=100.
- Instance-wide live SSE GET /api/event — synthetic server.connected
  first, capacity-256 dropping queue where overflow FAILS the stream
  (SubscriberOverflowError) — fail-fast, NOT lossy: client must
  reconnect + replay durable per-session streams. Deliberate pairing.
- Delta discipline: Text/Reasoning/Tool.Input/Compaction Deltas are
  LIVE-ONLY; *.Ended events carry full values and are durable. "Stream
  fragments are live-only; Text.Ended is the replayable full-value
  boundary."

## 4. Tool registry + permissions

- Tool.make: {description, input/output Schema, structured?,
  execute(input, ctx), toModelOutput?}; opaque frozen token, runtime in
  a WeakMap. Name rule /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.
  withPermission(tool, "read") re-brands the permission action.
- Registry: process-wide ApplicationTools + scoped local overrides
  (last-wins). materialize(permissions?) drops tools whose action is
  wholly denied; settle rejects "Stale tool call" if registration
  identity changed mid-run.
- v2 builtins: apply-patch, bash, edit, glob, grep, question, read,
  skill, todowrite, webfetch, websearch, write. TODO in code: task/LSP/
  plan_exit NOT yet ported to v2.
- Permissions: Rule{action, resource, effect allow|deny|ask}; LAST
  matching rule wins (findLast + wildcard both axes); default ask.
  Rulesets come from the AGENT; saved "always" grants appended as allow
  rules. reply: reject cascades to ALL pending of the session; "always"
  persists patterns per-project then auto-approves newly-covered
  pending. permission table: (project_id, action, resource) UNIQUE.
- Built-in agent rulesets (plugin/agent.ts:106-203): build = allow-all +
  ask on *.env read + ask external_directory; explore = deny-all +
  allow grep/glob/read/webfetch/websearch.

## 5. Storage

drizzle-orm over bun:sqlite. Key tables: session (cost, tokens_*,
revert json, agent, model json, time_compacting...), session_message
(id, session_id, type, seq, data json, UNIQUE(session_id, seq)) — the
projection of durable events into conversation rows, session_input,
session_context_epoch, event + event_sequence, permission, credential,
project, workspace, todo. V1-compat message/part tables kept.

Migrations: TypeScript {id, up(tx)} files aggregated by generated
migration.gen.ts; fresh DB applies generated baseline schema.gen.ts then
marks all complete; journal table migration(id, time_completed).

## 6. Agents / subagents

- Agent Info schema: {id, model? Ref{id, providerID, variant?}, request
  {headers, body}, system?, description?, mode subagent|primary|all,
  hidden, color?, steps? (max-steps bound), permissions Ruleset}.
- Built-ins: build, plan, general (subagent), explore (subagent) +
  hidden primaries compaction/title/summary WITH INLINE PROMPTS —
  compaction is just a hidden agent.
- Config agents from markdown: glob {agent,agents}/**/*.md, gray-matter
  frontmatter + sanitizer for unquoted-colon values.
- steps enforcement: runner/llm.ts:203-214 — isLastStep → no tools,
  toolChoice "none", MAX_STEPS prompt.
- SUBAGENTS NOT WIRED IN V2: session.parent_id column exists but v2
  create payload has no parent; no v2 task tool (TODO in builtins).
  Task tool with task_id resume/depth bound/background lives in V1 only
  (packages/opencode/src/tool/task.ts). For deepseek-code: design from
  V1 tool + v2 session primitives; there is no v2 code to port.

## 7. Server embedding

- makeRoutes(authLayer) composes HttpApiBuilder layer + handlers +
  middleware + service graph. Basic auth ONLY when password set;
  unauthenticated remains the local default (confirmed AVOID item).
- Embedded: sdk-next createEmbeddedRoutes() (password None => no auth
  in-process) → HttpRouter.toWebHandler → fake fetch into the generated
  typed client. Same router, same middleware, zero listener; local vs
  remote byte-identical because the client only sees fetch.
- Endpoint groups declared once in protocol/src/groups/*.ts, implemented
  in server/src/handlers/*.ts, codegen'd client in client/src/generated.

## Corrections to SOURCES.md

1. Core v2 supports only 3 routes via catalog mapping; llm facades
   (incl. deepseek profile) are not what the loop consumes.
2. session_input is an event-stream projection (seqs are event seqs),
   not an independent queue.
3. Epoch cuts: first turn, compaction-newer-than-baseline,
   codec-incompatible, removed-without-renderer (last two were missing).
4. Instance-wide stream overflow FAILS the stream (fail-fast), pairing
   with durable replay — not silent loss.
5. v2 subagent orchestration does not exist yet; V1 is the only
   reference implementation.
