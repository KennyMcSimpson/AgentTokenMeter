# Changelog

## 2.0.0 — AgentTokenMeter Multi-Agent Release

### Added
- **Multi-Agent Adapters**: First-class incremental adapters for **Antigravity**, **Claude Code** (streaming LWW dedup, `subagents/` isolation, 5m/1h prompt cache write tiers), and **Codex** (cumulative `total_token_usage` delta dedup, inclusive `cached_input_tokens` subtraction, `reasoning_output_tokens` subset handling, `turn_context` model tracking).
- **Host-Scoped Views & End-to-End Allowlist Isolation**: Antigravity sidecar defaults to `antigravity`; Claude Code `statusLine` defaults to `--agent claude-code`; dynamic switcher hides automatically for single-agent setups; `TOKEN_METER_AGENTS` and `serve --agent <id> --only` enforce strict end-to-end isolation.
- **Unified v2 Persistent Ledger**: Namespaced event keys (`agent:sessionId:eventId`), canonical disjoint token buckets (`in`, `cr`, `cw5`, `cw1h`, `out`, `r`), backward compatibility with v1 Antigravity ledgers, and Windows `EPERM/EBUSY`-resilient atomic writes.
- **Multi-Provider Pricing Engine**: Official Google Gemini, Anthropic Claude, and OpenAI GPT/Codex rate cards, honest `unpriced` marking for unknown models, and `<dataDir>/pricing.override.json` support for custom models and channel multipliers.
- **Zero-Conflict Multi-Host Packaging**: Coexisting manifests & hooks for Antigravity (`plugin.json`, `hooks.json`, `sidecars/dashboard`), Claude Code (`.claude-plugin/`, `hooks/hooks.json`), and Codex (`.codex-plugin/`), plus non-destructive `install` / `uninstall` CLI helpers with `--dry-run`.
- **Shared Frontend + Standalone Web Server**: Single `ui/` frontend powered by `HostBridge`, served both inside Antigravity's Auxiliary Pane sidecar and via a zero-dependency local `127.0.0.1` HTTP server (`bin/token-meter.mjs serve`), with agent filter pills, cross-agent breakdown bar, and cache-write visualization.
- **Claude Code `statusLine` HUD**: Fast single-line usage indicator via `bin/token-meter.mjs statusline`.
