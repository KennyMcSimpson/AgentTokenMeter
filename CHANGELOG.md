# Changelog

## 2.1.0 — Sub-Second Sidecar Switching, Deep Workflow/Tier Accounting & Multi-Account Discovery

### Fixed
- **Antigravity Sidecar Switching Livelock & Large-Ledger Performance**: Eliminated the 5-second poll-vs-click cancellation livelock in `ui/app.js` (cancelling pending polls during interactive clicks, stripping `AbortSignal` before `window.sidecar.fetch` to avoid Chromium IPC `DataCloneError`, and requesting `noSync=1` on instant filter switches). Deferred initial sidecar warmup sync until after `app.run()` binds, memoized `resolveModelRate()` and hourly-validated `localDateKey()`, cached parsed ledger snapshots and LRU reports with UTC-midnight and inode-aware ETag invalidation, and compacted `cursors.json` (stripping dead resume buffers on immutable `.jsonl.zst` archives), cutting 794K-event switches from ~9–11 s to 1 ms–0.8 s.
- **Claude Code Deep Workflow Subagents & Hidden Usage**: Expanded recursive scanning from depth 3 to depth 8 (capturing nested `<project>/<session>/subagents/workflows/wf_*/agent-*.jsonl` transcripts while safely scoping `subagents` detection inside discovered project roots), summed server-side `usage.iterations[]` (compaction / Advisor turns while preserving top-level 1h cache-write splits and iteration `thinking_tokens`), captured `output_tokens_details.thinking_tokens`, `speed: "fast"`, and `inference_geo: "us"`, and parsed leading `>16 KB` `file-history-snapshot` lines carrying `sessionId`.
- **Codex Service Tiers & Edge-Case Accuracy**: Tracked `service_tier` (`priority` / `fast` = 2x, `flex` = 0.5x, plus `null` / `auto` / `default` resets) across `thread_settings_applied`, `turn_context`, `token_usage_record`, `token_count`, and `tc -> ur` handoffs, and handled legacy `last_usage_includes_reasoning === false` fallback entries.
- **Antigravity Accounting & ReDoS Guard**: Bounded `MODEL_CHANGE_RE` to eliminate quadratic backtracking and prevent sentence-crossing captures, accepted terminal non-`DONE` (`ERROR`/`CANCELLED`) billed steps while still skipping in-flight statuses, guarded against whitespace-only `model` fields, backfilled earlier `unknown` steps via `firstModel` and widened `step_index <= 10` parent inheritance, and added `'tiered'` to allowed model suffixes.

### Added
- **Official Anthropic Claude 5 & Service-Tier Pricing**: Added official rates for `claude-opus-5`, `claude-fable-5-1`, and `claude-fable-5-2` in `core/rate-card.mjs`, plus official OpenAI/Anthropic Fast (`2x`), OpenAI Flex (`0.5x`), and Anthropic US residency (`1.1x`) multipliers (gated strictly to official catalog rates without polluting `pricing.override.json`).
- **Multi-Account Local Profile Discovery**: Auto-discovers sibling local config directories (`~/.claude-*`, `~/.config/claude*`, `~/.codex-*`, `~/.gemini*`, plus delimiter-separated `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides) deduplicated via `realpathSync`.
- **One-Time Legacy v1 Antigravity Archive Import**: Non-destructively imports historical Antigravity sessions (and `parentSessionId` chains) from `~/.gemini/token-meter` (or `TOKEN_METER_LEGACY_AG_DIR`) that were later removed from live brain directories, never overwriting live v2/v3 events.

## 2.0.3 — File-Namespace Archive Preservation, Zero-Duplicate Hook Upgrades & Locked First-Model Backfill

### Fixed
- **Same-Thread Archived Sibling Preservation**: Scoped ledger replacement in `compactEventsPreservingArchived` and `core/sync.mjs` to file-level namespaces `(agent, sessionId, rolloutId)`, so deleting an original Codex rollout while keeping its `<threadId>_<rolloutId>` revert sibling (or vice versa) preserves the deleted file's archived events across both upgrades and `sync --full`.
- **Zero Temporary Double-Counting on Hook-First Legacy Upgrades**: When `syncSingleSource` upgrades an isolated legacy file (no sibling sharing the legacy namespace), it now atomically compacts that namespace immediately so `summary --no-sync` stays exact; when a sibling shares the legacy namespace (e.g. v2.0.0 fork collision) or under fast `statusline` lock budgets, it defers without appending duplicate events until the next `syncAllSources()`.
- **Stable Cross-Batch Codex Model Backfill**: Persisted `pendingUnknownEvents` in Codex file cursors to rewrite earlier `unknown` events directly in the ledger (LWW) as soon as the first `turn_context` arrives, and recorded immutable `firstModel` in session metadata so later mid-session model switches never retroactively rewrite earlier turns.
- **Consistent OpenAI Cache-Write Rate Policy**: Unified `gpt-5.5` with `gpt-5.4` at `1.0x` input rate for cache writes (neither has published separate cache-write rates on OpenAI docs), while retaining official `1.25x` / `2.5x` rates on GPT-6.x and GPT-5.6 models and explicitly noting estimated `>272K` long-context cache-write scaling in `tierNote`.

## 2.0.2 — Large `.jsonl.zst` Streaming, Native Revert Filenames, Seamless Ledger Upgrades & Rate Accuracy

### Fixed
- **Large `.jsonl.zst` Archives (>256 MiB) & Skipped-File Visibility**: Replaced full-file record buffering with single-pass streaming line feeding and frame-by-frame zstd decompression (2 GiB default safety cap, overridable via `TOKEN_METER_MAX_ZSTD_BYTES`), and surfaced any unreadable/skipped source files in `sync` output and `summary` warnings instead of dropping silently.
- **Native Codex 0.171 Revert Filenames (`<threadId>_<rolloutId>`)**: Parsed `<threadId>_<rolloutId>.jsonl[.zst]` so the first UUID locks the thread session ID and the second UUID namespaces event keys (`rev:<rolloutId>:tc:N`), matching Codex `rollout_file_name.rs`.
- **Clean Legacy Ledger Upgrades (v2.0.0 / v2.0.1 → v2.0.2)**: Added `parserVersion` tracking to Codex cursors and session-scoped replacement (`replaceSessionKeys`) in `compactEventsPreservingArchived`, automatically rescanning upgraded sessions and purging stale misattributed keys while still preserving archived events from deleted transcripts.
- **OpenAI Rate Card Accuracy**: Corrected `gpt-6-sol` cached input to `$0.20/M` (`$0.40/M` at `>272K`) and applied official OpenAI 30-minute prompt cache write pricing (`1.25x` input, doubled at `>272K`) to GPT-6.x / GPT-5.6 / GPT-5.5 models.
- **Codex Metadata Edge Cases**: Extracted nested `payload.source.subagent.thread_spawn.parent_thread_id` for subagent lineage, and backfilled cross-batch pre-`turn_context` `unknown` Codex events in `buildReport()` as soon as the session's model arrives.
- **Installer Comment Accuracy**: Corrected Unix hook execution comment in `bin/installer.mjs` to reflect login shell (`-lc`).

## 2.0.1 — Codex 0.171 Compatibility, Archive Coverage & Pricing Accuracy

### Fixed
- **Codex Forked/Subagent Rollout Key Collisions**: Lock each rollout file to its first matching `session_meta` (persisted via `sessionMetaSeen` in cursors) and populate `parentSessionId` from `parent_thread_id` / `forked_from_id`, preventing copied parent `session_meta` entries from colliding with parent event keys; disambiguate `-revert-<rolloutId>` filenames from `<threadId>`.
- **Codex Delayed Replay & `token_usage_record` Support**: Guard against delayed replays of previously seen `total_token_usage` snapshots and prefer per-request `token_usage_record.usage` when present.
- **Codex Compressed & Archived History Coverage**: Scan both `$CODEX_HOME/sessions/` and `$CODEX_HOME/archived_sessions/` for `.jsonl` and `.jsonl.zst` files (using built-in Node.js `>=22.15.0` `node:zlib` zstd decompression), deduplicating across `.jsonl` → `.jsonl.zst` transitions and adding first `turn_context` model lookahead.
- **Codex `cache_write_input_tokens` Normalization**: Subtract `cache_write_input_tokens` from inclusive `input_tokens` and record it under `cw5`.
- **Cross-Agent `activeSession` Isolation**: Restrict `buildReport()` `activeSession` lookup to the allowed/filtered agent scope and return `null` when unmatched instead of leaking foreign session metadata.
- **Codex `SubagentStop` Hook Routing**: Infer host from `turn_id` / path instead of hardcoding `claude-code` for `agent_transcript_path`.
- **Codex Installer Polish**: Preserve optional top-level `description` in `hooks.json` on install/uninstall, drop redundant `commandWindows` (while still cleaning up legacy entries on uninstall), and surface a clear Codex 0.171+ hook trust approval reminder in installer output and README.

### Added
- **OpenAI Official Rate Card & `>272K` Long-Context Tiering**: Added verified official rates for `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-terra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.5`, plus `>272K` long-context pricing (`2x` input/cache, `1.5x` output) across extended-context GPT-5.4 / GPT-5.5 / GPT-5.6 / GPT-6.x models.

## 2.0.0 — AgentTokenMeter Multi-Agent Release

### Added
- **Multi-Agent Adapters**: First-class incremental adapters for **Antigravity**, **Claude Code** (streaming LWW dedup, `subagents/` isolation, 5m/1h prompt cache write tiers), and **Codex** (cumulative `total_token_usage` delta dedup, inclusive `cached_input_tokens` subtraction, `reasoning_output_tokens` subset handling, `turn_context` model tracking).
- **Host-Scoped Views & End-to-End Allowlist Isolation**: Antigravity sidecar defaults to `antigravity`; Claude Code `statusLine` defaults to `--agent claude-code`; dynamic switcher hides automatically for single-agent setups; `TOKEN_METER_AGENTS` and `serve --agent <id> --only` enforce strict end-to-end isolation.
- **Unified v2 Persistent Ledger**: Namespaced event keys (`agent:sessionId:eventId`), canonical disjoint token buckets (`in`, `cr`, `cw5`, `cw1h`, `out`, `r`), backward compatibility with v1 Antigravity ledgers, and Windows `EPERM/EBUSY`-resilient atomic writes.
- **Multi-Provider Pricing Engine**: Official Google Gemini, Anthropic Claude, and OpenAI GPT/Codex rate cards, honest `unpriced` marking for unknown models, and `<dataDir>/pricing.override.json` support for custom models and channel multipliers.
- **Zero-Conflict Multi-Host Packaging**: Coexisting manifests & hooks for Antigravity (`plugin.json`, `hooks.json`, `sidecars/dashboard`), Claude Code (`.claude-plugin/`, `hooks/hooks.json`), and Codex (`.codex-plugin/`), plus non-destructive `install` / `uninstall` CLI helpers with `--dry-run`.
- **Shared Frontend + Standalone Web Server**: Single `ui/` frontend powered by `HostBridge`, served both inside Antigravity's Auxiliary Pane sidecar and via a zero-dependency local `127.0.0.1` HTTP server (`bin/token-meter.mjs serve`), with agent filter pills, cross-agent breakdown bar, and cache-write visualization.
- **Claude Code `statusLine` HUD**: Fast single-line usage indicator via `bin/token-meter.mjs statusline`.
