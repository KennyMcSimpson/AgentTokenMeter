<p align="center">
  <img src="assets/logo.svg" width="84" height="84" alt="AgentTokenMeter Logo" />
</p>

<h1 align="center">AgentTokenMeter</h1>

<p align="center">
  Zero-dependency local token usage, prompt cache hit/write analytics, and multi-provider official API cost tracker for <strong>Antigravity</strong>, <strong>Claude Code</strong>, and <strong>Codex</strong> — one repository, one persistent ledger, native host plugins + live web dashboard.
</p>

<p align="center">
  <a href="./CHANGELOG.md">Changelog</a> · <a href="./LICENSE">MIT License</a>
</p>

> **Inspiration & Credit**: The architecture and design philosophy of this project (zero-dependency Node.js ESM, incremental `Stop` hook archiving, late-binding pricing, and a live local dashboard) were directly inspired by [NianJiuZst/antigravity-token-meter](https://github.com/NianJiuZst/antigravity-token-meter) and generalized here to work natively across Antigravity, Claude Code, and Codex.

---

## Highlights

- **Single Repo, Multi-Agent Native**: Coexisting manifests and hooks for **Antigravity**, **Claude Code**, and **Codex** with zero configuration conflicts.
- **Host-Scoped by Default, Combined on Demand**:
  - Inside **Antigravity**, the side pane defaults to showing **Antigravity** alone (automatically revealing a switcher only when logs from additional agents exist).
  - Inside **Claude Code**, `install statusline` defaults to `--agent claude-code` (pass `--all` for combined totals).
  - The shared agent skill defaults to querying the current host agent and switches to `--agent all` when asked for combined totals.
  - Set `TOKEN_METER_AGENTS=<agent>` or `serve --agent <agent> --only` for strict single-agent isolation across scanning, hooks, API, and CSV export.
- **Exact Per-Agent Accounting (No Double-Counting)**:
  - **Antigravity**: Disjoint `input_tokens` / `cache_read_tokens`, torn-line protection, Swarm/Subagent titles, and parent model inheritance.
  - **Claude Code**: Streaming `(message.id, requestId)` last-write-wins deduplication, `subagents/agent-*.jsonl` isolation, and 5-minute (`1.25x`) vs 1-hour (`2.0x`) `cache_creation` pricing tiers.
  - **Codex**: Cumulative `total_token_usage` delta deduplication (eliminating duplicate snapshot inflation), inclusive-to-disjoint `cached_input_tokens` subtraction, `reasoning_output_tokens` subset tracking, and `turn_context` model resolution.
- **Zero Dependencies & 100% Local**: Pure Node.js ESM (`>=22`). No `npm install`, no telemetry, no external network calls. Only normalized numeric metrics and short session titles are persisted under `~/.agent-token-meter/` (never raw message bodies).
- **Persistent Archive Ledger**: Monthly NDJSON ledger (`events/YYYY-MM.jsonl`) with cross-process file locking and Windows-safe atomic rewrites. Historical usage survives even if original transcripts are later cleaned up.
- **Multi-Provider Official Pricing + Custom Overrides**: Declarative official rate cards for **Google Gemini**, **Anthropic Claude**, and **OpenAI GPT / Codex** in `core/rate-card.mjs`, strict suffix matching (preventing mispricing of future minor versions/tiers), honest `unpriced` marking for unknown models, and optional `<dataDir>/pricing.override.json` for custom models or channel multipliers.

---

## Installation

### 1. Antigravity

Clone directly into your global Antigravity plugins directory:

```bash
git clone https://github.com/KennyMcSimpson/AgentTokenMeter.git ~/.gemini/config/plugins/agent-token-meter
```

Antigravity automatically discovers `plugin.json`, activates the root `Stop` hook, loads the `agent-token-meter` skill, and launches the live side-pane dashboard (`sidecar://agent-token-meter/dashboard/`).

### 2. Claude Code

**Option A — Native Plugin Marketplace:**

```text
/plugin marketplace add KennyMcSimpson/AgentTokenMeter
/plugin install agent-token-meter@agent-token-meter-marketplace
```

**Option B — Local Clone + Non-Destructive Hook & StatusLine Setup:**

```bash
git clone https://github.com/KennyMcSimpson/AgentTokenMeter.git ~/AgentTokenMeter
cd ~/AgentTokenMeter

# Preview changes safely with --dry-run first
node bin/token-meter.mjs install claude --dry-run
node bin/token-meter.mjs install claude

# Optional: add a compact live statusLine HUD (defaults to Claude Code only; pass --all for combined totals)
node bin/token-meter.mjs install statusline
```

### 3. Codex

Clone the repository and optionally wire the non-destructive `Stop` hook (strictly compliant with Codex `hooks.json` schema and Windows `commandWindows`):

```bash
git clone https://github.com/KennyMcSimpson/AgentTokenMeter.git ~/AgentTokenMeter
cd ~/AgentTokenMeter

# Preview first, then install Stop hook into $CODEX_HOME/hooks.json
node bin/token-meter.mjs install codex --dry-run
node bin/token-meter.mjs install codex
```

> Hooks are optional accelerators — even without installing any hook, `summary` and `serve` perform fast incremental scans across all enabled agent logs.

### 4. Standalone Local Web Dashboard (Single-Agent or Combined)

```bash
# Combined dashboard across all detected agents (auto-hides switcher if only 1 agent has data)
node bin/token-meter.mjs serve --port 3456

# Strict single-agent dashboard (scans and displays only Claude Code or Codex)
node bin/token-meter.mjs serve --port 3456 --agent claude-code --only
node bin/token-meter.mjs serve --port 3456 --agent codex --only
# Open http://127.0.0.1:3456
```

---

## CLI Reference

```bash
# 7-day cross-agent summary (auto-syncs new logs first)
node bin/token-meter.mjs summary --days 7

# Filter by agent: all | antigravity | claude-code | codex
node bin/token-meter.mjs summary --days 7 --agent claude-code
node bin/token-meter.mjs summary --days 7 --agent codex
node bin/token-meter.mjs summary --days 1 --agent antigravity

# All-time JSON report
node bin/token-meter.mjs summary --days 0 --json

# Launch local web dashboard (loopback only, DNS-rebinding protected)
node bin/token-meter.mjs serve --port 3456

# Compact one-line output for Claude Code statusLine
node bin/token-meter.mjs statusline --agent claude-code

# View built-in Google / Anthropic / OpenAI rate card
node bin/token-meter.mjs pricing

# Switch display currency (USD / CNY)
node bin/token-meter.mjs set-currency CNY --rate 7.25

# Export daily breakdown to CSV
node bin/token-meter.mjs export --days 30 --agent all --out usage.csv

# Full rescan & compaction (preserves archived records from deleted logs)
node bin/token-meter.mjs sync --full

# Cleanly remove installed hooks or statusLine (preserves third-party entries)
node bin/token-meter.mjs uninstall claude
node bin/token-meter.mjs uninstall statusline
node bin/token-meter.mjs uninstall codex
```

---

## Environment Variables & Custom Pricing

| Variable | Purpose |
| :--- | :--- |
| `TOKEN_METER_DATA_DIR` | Override ledger directory (default: `~/.agent-token-meter`) |
| `TOKEN_METER_AGENTS` | Comma-separated allowlist of enabled agents (e.g. `claude-code` or `antigravity,codex`) enforced end-to-end |
| `TOKEN_METER_DEFAULT_AGENT` | Override default initial view in the Antigravity sidecar (`antigravity` by default) |
| `TOKEN_METER_BRAIN_ROOTS` | Override Antigravity brain roots (`:` / `;` separated; empty string disables scan) |
| `TOKEN_METER_CLAUDE_ROOTS` | Override Claude Code project roots (defaults to `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`) |
| `TOKEN_METER_CODEX_ROOTS` | Override Codex session roots (defaults to `$CODEX_HOME/sessions` or `~/.codex/sessions`) |

Create `<dataDir>/pricing.override.json` to add custom models or apply channel/proxy multipliers:

```json
{
  "multipliers": {
    "antigravity": 1.0,
    "claude-code": 1.0,
    "codex": 1.0
  },
  "models": {
    "my-internal-model": {
      "provider": "custom",
      "input": 1.5,
      "cacheRead": 0.15,
      "cacheWrite5m": 1.875,
      "cacheWrite1h": 3.0,
      "output": 7.5
    }
  }
}
```

---

## Architecture

```text
AgentTokenMeter/
├── plugin.json                     # Antigravity root plugin manifest
├── hooks.json                      # Antigravity root Stop hook
├── .claude-plugin/
│   ├── plugin.json                 # Claude Code plugin manifest
│   └── marketplace.json            # Claude Code marketplace catalog
├── .codex-plugin/
│   └── plugin.json                 # Codex plugin manifest
├── hooks/
│   ├── hooks.json                  # Claude Code Stop & SubagentStop hooks
│   └── record.mjs                  # Universal cross-host Stop hook entrypoint
├── core/
│   ├── fs-utils.mjs                # Cross-process lock + Windows-safe atomic writes + JSONL collector
│   ├── jsonl-reader.mjs            # Shared offset/inode delta reader (torn-line & shrink safe)
│   ├── rate-card.mjs               # Declarative official Google / Anthropic / OpenAI rate table
│   ├── pricing.mjs                 # Pricing engine + strict suffix guard + overrides + prefs
│   ├── store.mjs                   # Unified v2 ledger (v1 backward compatible) + cache
│   ├── sync.mjs                    # Multi-adapter sync orchestration
│   └── report.mjs                  # Cross-agent aggregation, ETag & CSV export
├── adapters/
│   ├── index.mjs                   # Adapter registry, allowlist & path/content auto-detection
│   ├── antigravity.mjs             # ~/.gemini/*/brain adapter
│   ├── claude-code.mjs             # ~/.claude/projects adapter (LWW + subagents + 5m/1h CW)
│   └── codex.mjs                   # $CODEX_HOME/sessions adapter (cumulative delta + inclusive fix)
├── server/
│   ├── api.mjs                     # Transport-agnostic API controller
│   └── http.mjs                    # Zero-dep loopback HTTP server (Host/Origin validated)
├── sidecars/dashboard/             # Thin Antigravity SidecarApp wrapper
├── ui/                             # Single shared frontend (HTML / CSS / SVG JS + HostBridge)
├── bin/
│   ├── token-meter.mjs             # Unified CLI & Claude Code statusLine
│   └── installer.mjs               # Non-destructive config merger (--dry-run supported)
├── skills/agent-token-meter/
│   └── SKILL.md                    # Shared agent skill instructions (host-scoped by default)
└── test/                           # Unit, adapter, concurrency, security, HTTP/CLI & manifest tests
```

---

## Testing

```bash
npm test
# or
node --test test/*.test.mjs
```

---

## Credits & License

- Original concept and Antigravity reference implementation: [NianJiuZst/antigravity-token-meter](https://github.com/NianJiuZst/antigravity-token-meter) (MIT License).
- Multi-agent architecture, Claude Code & Codex adapters, standalone dashboard, and security hardening: [AgentTokenMeter](https://github.com/KennyMcSimpson/AgentTokenMeter) ([MIT License](./LICENSE)).
