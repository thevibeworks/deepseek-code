# goose scheduler — raw deep-dive notes (2026-08-03)

Source: reference/goose (Apache 2.0), agent deep dive. Paths relative to
reference/goose/. Raw material for devlog synthesis; see
docs/devlog/ for conclusions.

## 0. Topology

- crates/goose/src/scheduler.rs (1684 lines) — the only scheduler impl
- crates/goose/src/scheduler_trait.rs (46) — SchedulerTrait, 13 methods
- crates/goose/src/acp/server/schedule.rs (416) — ACP handlers
- crates/goose/src/agents/schedule_tool.rs (501) — platform__manage_schedule
- crates/goose-cli/src/commands/schedule.rs (345) — CLI verbs
- crates/goose-sdk-types/src/custom_requests/schedule.rs (169) — ACP wire types
- No temporal scheduler, no goosed schedule routes (deprecated stubs only).

## 1. Storage

- schedule.json at data_dir (scheduler.rs:143-147). Recipes COPIED into
  data_dir/scheduled_recipes/ as "{job.id}.{ext}" (scheduler.rs:462-468),
  written 0600, 1 MiB cap (MAX_SCHEDULE_RECIPE_BYTES scheduler.rs:33),
  symlink/FIFO defense O_NOFOLLOW + is_file recheck (scheduler.rs:50-74).
- Persist = rewrite whole JSON array from memory, plain fs::write, NO
  tmp+rename, NO flock (scheduler.rs:238-250) → last-writer-wins races
  between CLI and serve process.
- ScheduledJob (scheduler.rs:215-236): id, source (path in
  scheduled_recipes), cron, last_run, currently_running, paused,
  current_session_id, process_start_time, parameters Vec<(String,String)>,
  recipe_base_dir (so relative sub-recipe paths survive the copy).
- execution_mode is VESTIGIAL: read then ignored (schedule_tool.rs:155-159),
  not in tool schema; every run is in-process.
- In-memory: JobsMap HashMap + RunningTasksMap HashMap<String,
  CancellationToken> (scheduler.rs:30-31).
- Job sessions land in the same sqlite sessions.db with a schedule_id
  column + SessionType::Scheduled (session_manager.rs:45-54, 971).
  Job→session lookup = list_sessions filtered by schedule_id
  (scheduler.rs:761-782).
- Startup hygiene: stale currently_running/current_session_id cleared on
  load (scheduler.rs:252-260, 596-609); jobs with missing recipe file
  skipped but left in file (611-619).

## 2. Cron

- tokio-cron-scheduler 0.15 (Cargo.toml:142). Job::new_async_tz with
  LOCAL timezone (scheduler.rs:326-328).
- 5-field cron normalized to 6 by prepending "0"; 1-field @daily rejected
  by builder while the CLI validator advertises it — real mismatch
  (scheduler.rs:306-324 vs goose-cli commands/schedule.rs:28-48).

## 3. Headless execution path

- Fire closure (scheduler.rs:328-405): re-check paused → stamp
  last_run/currently_running/process_start_time → persist → create
  CancellationToken → await execute_job → deregister → clear running →
  persist → telemetry on failure.
- execute_job (scheduler.rs:985-1215) is fully IN-PROCESS — no subprocess,
  no `goose run --recipe`:
  - fresh Agent::new() per run (1015); provider/model from global Config
  - create_session with HOST PROCESS CWD, not recipe dir (1023-1032) —
    footgun
  - linkage via SessionConfig.schedule_id + session_type='scheduled'
  - current_session_id updated in memory but NOT persisted mid-run →
    observers see currently_running=true, session=null
  - prompt = recipe.prompt else instructions else error (1092-1104)
  - agent.reply(msg, SessionConfig{max_turns: None, retry_config: None},
    Some(cancel_token)); stream drained, first Err breaks (1124-1141)
- run_now awaits execute_job INLINE → the ACP run-now RPC blocks for the
  whole agent run, no progress streaming (scheduler.rs:784-849,
  acp/server/schedule.rs:286-297). Cancellation travels as an anyhow
  STRING that gets string-matched — fragile (838-841 / acp 99-106).

## 4. Reused vs duplicated

- Reused primitives: Agent, SessionManager, providers::create,
  resolve_extensions_for_new_session, build_recipe_from_template,
  agent.reply — same as interactive build_session.
- Duplicated: execute_job hand-rolls session bootstrap instead of calling
  build_session; loses provider fallback, apply_recipe_components,
  max_turns/retry, permission prompts, container support.
- Three recipe-ingest routes (CLI copy=true; ACP writes YAML itself;
  agent tool passes validated bytes) — drift surface.
- Every CLI verb constructs a fresh Scheduler whose tokio scheduler dies
  with the process → `schedule add` only edits the file; firing requires
  a long-lived process (`goose serve` with --enable-scheduler).

## 5. Management surface

- SchedulerTrait (scheduler_trait.rs:8-46): add/add_with_recipe/
  schedule_recipe/list/remove/pause/unpause/run_now/sessions/update/
  kill_running_job/get_running_job_info.
- ACP methods under _goose/unstable/: /schedules/{list,create,delete,
  update,run-now,pause,unpause}, /schedules/sessions/list,
  /schedules/running-job/{kill,inspect} (goose-sdk-types
  custom_requests/schedule.rs).
- Scheduler is OPT-IN: only with --enable-scheduler (server factory);
  `goose acp` stdio mode never starts it; desktop always passes the flag.
- Agent-facing tool platform__manage_schedule (10 actions incl.
  session_content) registered only when scheduler service exists
  (agents/agent.rs:1543-1546).
- ACP validates schedule-id charset + hidden chars; CLI validates neither.

## 6. Kill / inspect

- kill_running_job: pops + cancels the CancellationToken (cooperative
  only — the token handed to agent.reply), clears state immediately, no
  join → winding-down run can race the next cron fire
  (scheduler.rs:930-964).
- pause/update refuse while running; unpause does not (856-897).

## 7. Risks catalogued

1. Last-writer-wins on schedule.json (no atomic write, no lock).
2. current_session_id never flushed during a run.
3. run-now over ACP = synchronous long-poll.
4. @daily accepted by validator, rejected by builder.
5. Scheduled runs execute in host-process cwd, not recipe dir.
