---
name: agent-token-meter
description: Query daily token usage, prompt cache hit/write rates, top sessions, and official multi-provider equivalent API costs across Antigravity, Claude Code, and Codex, or launch the local web dashboard and export CSV reports.
---

# AgentTokenMeter

Query local token usage and equivalent official API costs across **Antigravity**, **Claude Code**, and **Codex** using a single persistent ledger (`~/.agent-token-meter/` by default, overridable via `TOKEN_METER_DATA_DIR`).

## Default Host Scope Rule

When installed inside a specific coding agent, **default to reporting only the current host agent** so each agent displays its own usage cleanly:

- Inside **Antigravity**: pass `--agent antigravity` by default.
- Inside **Claude Code**: pass `--agent claude-code` by default.
- Inside **Codex**: pass `--agent codex` by default.
- Pass `--agent all` only when the user explicitly asks for combined / cross-agent totals or comparisons across multiple agents.

## Locating the CLI

Resolve the CLI entry point relative to this skill directory (`../../bin/token-meter.mjs`), or invoke `agent-token-meter` if linked globally:

```bash
# Host-scoped 7-day summary (replace <host> with antigravity | claude-code | codex)
node <plugin-root>/bin/token-meter.mjs summary --days 7 --agent <host>

# Combined cross-agent summary when explicitly requested
node <plugin-root>/bin/token-meter.mjs summary --days 7 --agent all

# Today only / 30 days / All time (--days 0) & JSON
node <plugin-root>/bin/token-meter.mjs summary --days 1 --agent <host>
node <plugin-root>/bin/token-meter.mjs summary --days 30 --agent <host>
node <plugin-root>/bin/token-meter.mjs summary --days 0 --agent <host> --json

# Launch local web dashboard (single-agent locked or multi-agent)
node <plugin-root>/bin/token-meter.mjs serve --port 3456 --agent <host> --only
node <plugin-root>/bin/token-meter.mjs serve --port 3456

# Sync / full rescan & compaction (preserves archived events from deleted logs)
node <plugin-root>/bin/token-meter.mjs sync --agent <host>
node <plugin-root>/bin/token-meter.mjs sync --full

# View built-in official Google / Anthropic / OpenAI rate card
node <plugin-root>/bin/token-meter.mjs pricing

# Switch display currency (USD / CNY)
node <plugin-root>/bin/token-meter.mjs set-currency CNY

# Export daily breakdown to CSV
node <plugin-root>/bin/token-meter.mjs export --days 30 --agent <host> --out usage.csv
```

## Accounting Rules

- All adapters normalize raw logs into **disjoint** token buckets before persisting:
  - `Total Prompt Tokens = input + cacheRead + cacheWrite5m + cacheWrite1h`
  - `Total Tokens = Total Prompt Tokens + output` (`reasoning` is a display subset of `output`, never double-counted)
  - `Cache Hit Rate = cacheRead / Total Prompt Tokens`
- Pricing uses official Google Gemini, Anthropic Claude (including 5m / 1h cache writes), and OpenAI GPT/Codex rates. Unlisted models are honestly marked `unpriced` (customizable in `<dataDir>/pricing.override.json`).
- Inside Antigravity, when the side-pane UI is running, offer a one-click pill `[AgentTokenMeter](sidecar://agent-token-meter/dashboard/)`.
