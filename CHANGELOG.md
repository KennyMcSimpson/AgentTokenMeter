# Changelog

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
