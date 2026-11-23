import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJsonSafe } from '../core/fs-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function quoteArg(p) {
  return `"${String(p).replace(/"/g, '\\"')}"`;
}

function normCmd(s) {
  return String(s || '').replace(/\\/g, '/').toLowerCase();
}

function isOurHookCommand(cmd, repoRoot = REPO_ROOT) {
  if (typeof cmd !== 'string') return false;
  const norm = normCmd(cmd);
  const expectedScript = normCmd(join(repoRoot, 'hooks', 'record.mjs'));
  if (norm.includes(expectedScript)) return true;
  return norm.includes('hooks/record.mjs') && norm.includes('token-meter');
}

function isOurStatusLineCommand(cmd, repoRoot = REPO_ROOT) {
  if (typeof cmd !== 'string') return false;
  const norm = normCmd(cmd);
  const expectedCli = normCmd(join(repoRoot, 'bin', 'token-meter.mjs'));
  if (norm.includes(expectedCli) && norm.includes('statusline')) return true;
  return norm.includes('bin/token-meter.mjs') && norm.includes('statusline');
}

export function resolveClaudeSettingsPath() {
  const base = process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR.trim() : join(homedir(), '.claude');
  return join(base, 'settings.json');
}

export function resolveCodexHooksPath() {
  const base = process.env.CODEX_HOME ? process.env.CODEX_HOME.trim() : join(homedir(), '.codex');
  return join(base, 'hooks.json');
}

function readStrictJsonObject(filePath) {
  if (!existsSync(filePath)) return {};
  const parsed = readJsonSafe(filePath, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Refusing to modify invalid JSON file: ${filePath}`);
  }
  return parsed;
}

/**
 * Non-destructively strip ONLY our hook entries from hook groups, preserving any
 * third-party hooks that share the same matcher group.
 */
function stripOurHookEntries(groups, repoRoot) {
  if (!Array.isArray(groups)) return { next: [], removed: false };
  const next = [];
  let removed = false;

  for (const group of groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      next.push(group);
      continue;
    }
    const keptHooks = group.hooks.filter(
      (h) => !isOurHookCommand(h?.command, repoRoot) && !isOurHookCommand(h?.commandWindows, repoRoot),
    );
    if (keptHooks.length !== group.hooks.length) {
      removed = true;
    }
    if (keptHooks.length > 0) {
      next.push({ ...group, hooks: keptHooks });
    }
  }

  return { next, removed };
}

function upsertHookEvent(hooksObj, eventName, entry, repoRoot) {
  const { next } = stripOurHookEntries(hooksObj[eventName], repoRoot);
  next.push({ hooks: [entry] });
  hooksObj[eventName] = next;
}

function removeHookEvent(hooksObj, eventName, repoRoot) {
  if (!Array.isArray(hooksObj[eventName])) return false;
  const { next, removed } = stripOurHookEntries(hooksObj[eventName], repoRoot);
  if (next.length === 0) {
    delete hooksObj[eventName];
  } else {
    hooksObj[eventName] = next;
  }
  return removed;
}

function buildCodexWindowsPowerShellCmd(nodeCmd) {
  // Codex executes `commandWindows` under PowerShell on Windows;
  // `--%` stops PowerShell from mangling quotes/operators before handing off to cmd.exe.
  return `cmd.exe --% /d /s /c "cd . && ${nodeCmd}"`;
}

export function installTarget(target, { dryRun = false, force = false, allAgents = false, repoRoot = REPO_ROOT } = {}) {
  const recordScript = join(repoRoot, 'hooks', 'record.mjs');
  const cliScript = join(repoRoot, 'bin', 'token-meter.mjs');
  const recordCmd = `node ${quoteArg(recordScript)}`;
  const statusAgent = allAgents ? 'all' : 'claude-code';
  const statusCmd = `node ${quoteArg(cliScript)} statusline --agent ${statusAgent}`;

  if (target === 'claude' || target === 'claude-hooks') {
    const path = resolveClaudeSettingsPath();
    const cfg = readStrictJsonObject(path);
    const next = structuredClone(cfg);
    if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
    const entry = { type: 'command', command: recordCmd, timeout: 10 };
    upsertHookEvent(next.hooks, 'Stop', entry, repoRoot);
    upsertHookEvent(next.hooks, 'SubagentStop', entry, repoRoot);
    if (!dryRun) atomicWriteJson(path, next);
    return { target: 'claude-hooks', path, dryRun, config: next };
  }

  if (target === 'statusline' || target === 'claude-statusline') {
    const path = resolveClaudeSettingsPath();
    const cfg = readStrictJsonObject(path);
    const existing = cfg.statusLine;
    if (existing && !force && !isOurStatusLineCommand(existing.command, repoRoot)) {
      throw new Error(
        `Existing Claude Code statusLine detected (${existing.command || 'custom'}). Pass --force to overwrite.`,
      );
    }
    const next = structuredClone(cfg);
    next.statusLine = {
      type: 'command',
      command: statusCmd,
      padding: 0,
    };
    if (!dryRun) atomicWriteJson(path, next);
    return { target: 'claude-statusline', path, dryRun, config: next };
  }

  if (target === 'codex' || target === 'codex-hooks') {
    const path = resolveCodexHooksPath();
    const cfg = readStrictJsonObject(path);
    // Codex Rust HooksFile uses #[serde(deny_unknown_fields)]: top-level MUST only contain `hooks`.
    const existingHooks = cfg.hooks && typeof cfg.hooks === 'object' ? structuredClone(cfg.hooks) : {};
    upsertHookEvent(
      existingHooks,
      'Stop',
      {
        type: 'command',
        command: recordCmd,
        commandWindows: buildCodexWindowsPowerShellCmd(recordCmd),
        timeout: 10,
      },
      repoRoot,
    );
    const next = { hooks: existingHooks };
    if (!dryRun) atomicWriteJson(path, next);
    return { target: 'codex-hooks', path, dryRun, config: next };
  }

  throw new Error(`Unknown install target "${target}". Supported: claude, statusline, codex`);
}

export function uninstallTarget(target, { dryRun = false, repoRoot = REPO_ROOT } = {}) {
  if (target === 'claude' || target === 'claude-hooks') {
    const path = resolveClaudeSettingsPath();
    if (!existsSync(path)) return { target: 'claude-hooks', path, changed: false, dryRun };
    const cfg = readStrictJsonObject(path);
    const next = structuredClone(cfg);
    let changed = false;
    if (next.hooks && typeof next.hooks === 'object') {
      changed = removeHookEvent(next.hooks, 'Stop', repoRoot) || changed;
      changed = removeHookEvent(next.hooks, 'SubagentStop', repoRoot) || changed;
      if (Object.keys(next.hooks).length === 0) delete next.hooks;
    }
    if (changed && !dryRun) atomicWriteJson(path, next);
    return { target: 'claude-hooks', path, changed, dryRun };
  }

  if (target === 'statusline' || target === 'claude-statusline') {
    const path = resolveClaudeSettingsPath();
    if (!existsSync(path)) return { target: 'claude-statusline', path, changed: false, dryRun };
    const cfg = readStrictJsonObject(path);
    const next = structuredClone(cfg);
    let changed = false;
    if (next.statusLine && isOurStatusLineCommand(next.statusLine.command, repoRoot)) {
      delete next.statusLine;
      changed = true;
    }
    if (changed && !dryRun) atomicWriteJson(path, next);
    return { target: 'claude-statusline', path, changed, dryRun };
  }

  if (target === 'codex' || target === 'codex-hooks') {
    const path = resolveCodexHooksPath();
    if (!existsSync(path)) return { target: 'codex-hooks', path, changed: false, dryRun };
    const cfg = readStrictJsonObject(path);
    const existingHooks = cfg.hooks && typeof cfg.hooks === 'object' ? structuredClone(cfg.hooks) : {};
    const changed = removeHookEvent(existingHooks, 'Stop', repoRoot);
    if (changed && !dryRun) atomicWriteJson(path, { hooks: existingHooks });
    return { target: 'codex-hooks', path, changed, dryRun };
  }

  throw new Error(`Unknown uninstall target "${target}". Supported: claude, statusline, codex`);
}
