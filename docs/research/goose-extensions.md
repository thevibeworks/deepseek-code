# goose extension system — raw deep-dive notes (2026-08-03)

Source: reference/goose (Apache 2.0), agent deep dive. Paths relative to
reference/goose/. Raw material for devlog synthesis.

## 1. Extension types (agents/extension.rs)

ExtensionConfig, internally tagged by `type`, 7 variants:
- `stdio` — cmd/args/envs/env_keys/timeout/cwd/available_tools (174-196)
- `builtin` — in-process goose-mcp servers over tokio duplex pair (197-212)
- `platform` — pure in-process, no transport, client_factory fn (213-227)
- `streamable_http` — uri/headers/timeout, optional Unix socket (228-257)
- `frontend` — tools executed by the UI client (258-275)
- `inline_python` — code string run via `uvx --with mcp python` (276-294)
- `sse` — dead, parse-only for back-compat; rejected at connect
- available_tools: empty = all, else strict per-extension tool allowlist
  (418-444), enforced at list AND dispatch time.
- Envs newtype with 31-key blocklist (PATH, LD_PRELOAD, NODE_OPTIONS,
  PYTHONPATH...) stripped silently on deserialize (80-132).
- resolve(): keyring secrets merged, $VAR substitution into
  uri/headers/cwd/socket, deliberately non-recursive (446-512).

## 2. MCP substrate

- rmcp 3.0.0 (Cargo.toml:23). McpClient wraps RunningService; goose
  serves MCP sampling requests with its OWN provider (mcp_client.rs:384)
  and elicitation via ActionRequiredManager (470).
- Builtin extensions connect over tokio::io::duplex(65536) — in-process
  MCP without a subprocess (extension_manager.rs:1059-1074). Subprocess
  only inside Docker jail (docker exec ... goose mcp <name>).
- stdio spawn: command resolved through SearchPaths with npm, stderr
  piped and captured into init-failure errors, process_group(0) +
  parent-death signal (subprocess.rs:7-70).
- OAuth for streamable_http: proactive refresh + 401 sniffing + browser
  fallback; creds cleared on post-refresh 401 (663-803).

## 3. Tool namespacing

- `{extension}__{tool}` prefix (extension_manager.rs:1424-1428); platform
  defs may set unprefixed_tools (developer/skills/analyze/summon/
  code_execution are bare-named).
- Ownership ALSO carried in tool _meta["goose_extension"]; resolve_tool
  prefers meta, falls back to prefix split; one-shot
  recover_mangled_tool_name repairs `functions.x` / `ext.tool` model
  typos, aborting on ambiguity (280-308, 1702-1793).
- Global dedupe: later duplicate tool names dropped with warning.

## 4. Config

- ~/.config/goose/config.yaml, `extensions:` map of key →
  { enabled: bool, ...flattened ExtensionConfig } (config/extensions.rs).
- Map key doubles as tool prefix after sanitization (name_to_key:
  lowercase, strip whitespace, non-[A-Za-z0-9_-] → _).
- Bad entries skipped INDIVIDUALLY with key logged; siblings preserved
  byte-for-byte (55-82) — resilient config parsing.
- Secrets in OS keyring (service "goose") or secrets.yaml fallback.
- resolve_extensions_for_new_session precedence: recipe > CLI override >
  config (296-312).

## 5. Runtime enable/disable

- Manager add_extension idempotent on identical raw+resolved config;
  RESTARTS server if either differs — catches secret rotation
  (938-954). remove drops record; client Drop kills child.
- Tools cache with AtomicU64 version, invalidated on add/remove.
- LLM-facing: platform extension `extensionmanager` with
  manage_extensions + search_available_extensions tools — the agent can
  reconfigure itself, but manage_extensions ALWAYS requires user
  approval (permission_inspector.rs:177-181).
- update_working_dir re-pushes MCP roots to all live clients.

## 6. Security posture

- NO command allowlist for extensions (confirmed absent).
- Supply-chain check before every stdio spawn: parse npx/uvx target,
  query OSV API, deny on MAL-* advisories, fail-OPEN on HTTP error
  (extension_malware_check.rs).
- MCP-app meta spoofing defense: strip server-supplied trusted-meta keys,
  re-insert goose's own (324-370).
- permission.yaml keyed on PREFIXED tool name; levels + principals
  (user / smart_approve); extension removal purges its permission
  entries by prefix.
- Permission pipeline: Chat-mode skip → Auto allow → user perm →
  read-only annotation → forced-approval list → LLM read-only judge
  (permission_judge.rs, sentinel tool platform__tool_by_tool_permission)
  → default ask.
- Optional Docker jail for stdio and builtin extensions.

## 7. Platform vs builtin split

- PLATFORM_EXTENSIONS (in-process, direct agent/session access):
  analyze, todo, apps, chatrecall, extensionmanager, summon, summarize,
  code_execution, developer, orchestrator (hidden), tom, skills.
  `developer` (write/edit/shell/tree/read_image) is a platform
  extension, NOT an MCP server — core tools bypass MCP entirely.
- Builtin registry (goose-mcp crate, still in-process via duplex):
  autovisualiser, computercontroller, memory, tutorial.
- Takeaway: goose runs core tools in-process and reserves MCP for
  genuinely external integrations — same conclusion our design reached
  (skills+tools core, MCP not in core), while showing what a clean
  extension seam looks like if we ever add one.
