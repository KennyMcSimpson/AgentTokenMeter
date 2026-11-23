import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearLedgerCache } from '../core/store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const HOOK_SCRIPT = join(REPO_ROOT, 'hooks', 'record.mjs');
export const CLI_SCRIPT = join(REPO_ROOT, 'bin', 'token-meter.mjs');

export function createTestEnv(prefix = 'atm-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(root, 'data');
  const agBrainDir = join(root, 'antigravity', 'brain');
  const claudeDir = join(root, 'claude');
  const claudeProjectsDir = join(claudeDir, 'projects');
  const codexDir = join(root, 'codex');
  const codexSessionsDir = join(codexDir, 'sessions');

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agBrainDir, { recursive: true });
  mkdirSync(claudeProjectsDir, { recursive: true });
  mkdirSync(codexSessionsDir, { recursive: true });

  const env = {
    ...process.env,
    TOKEN_METER_DATA_DIR: dataDir,
    TOKEN_METER_BRAIN_ROOTS: agBrainDir,
    TOKEN_METER_CLAUDE_ROOTS: claudeProjectsDir,
    TOKEN_METER_CODEX_ROOTS: codexSessionsDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
  };

  // Save/restore process.env for in-process sync calls
  const savedEnv = {};
  const keys = [
    'TOKEN_METER_DATA_DIR',
    'TOKEN_METER_AGENTS',
    'TOKEN_METER_DEFAULT_AGENT',
    'TOKEN_METER_BRAIN_ROOTS',
    'TOKEN_METER_CLAUDE_ROOTS',
    'TOKEN_METER_CODEX_ROOTS',
    'TOKEN_METER_MAX_ZSTD_BYTES',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
  ];
  for (const k of keys) {
    savedEnv[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  clearLedgerCache();

  return {
    root,
    dataDir,
    agBrainDir,
    claudeDir,
    claudeProjectsDir,
    codexDir,
    codexSessionsDir,
    env,

    mkAgTranscript(convId) {
      const dir = join(agBrainDir, convId, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      return join(dir, 'transcript.jsonl');
    },

    mkClaudeTranscript(projectSlug, sessionId, subagentName = '') {
      const dir = subagentName
        ? join(claudeProjectsDir, projectSlug, sessionId, 'subagents')
        : join(claudeProjectsDir, projectSlug);
      mkdirSync(dir, { recursive: true });
      return join(dir, `${subagentName || sessionId}.jsonl`);
    },

    mkCodexRollout(datePath, fileName) {
      const dir = join(codexSessionsDir, ...datePath.split('/'));
      mkdirSync(dir, { recursive: true });
      return join(dir, fileName);
    },

    runHook(payload) {
      return execFileSync(process.execPath, [HOOK_SCRIPT], {
        input: JSON.stringify(payload),
        env,
        encoding: 'utf-8',
      });
    },

    runCli(...args) {
      return execFileSync(process.execPath, [CLI_SCRIPT, ...args], {
        env,
        encoding: 'utf-8',
      });
    },

    cleanup() {
      clearLedgerCache();
      for (const k of keys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
