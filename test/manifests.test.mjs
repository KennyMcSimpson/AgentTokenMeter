import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './helpers.mjs';

function readJson(relPath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf-8'));
}

test('Multi-host plugin manifests & hooks have zero schema or naming conflicts', () => {
  // 1. Antigravity root plugin.json: only documented allowed top-level fields
  const allowedAgFields = new Set([
    'name',
    'displayName',
    'version',
    'description',
    'logo',
    'author',
    'homepage',
    'repository',
    'suggestedPrompts',
    'disabled',
  ]);
  const agManifest = readJson('plugin.json');
  for (const key of Object.keys(agManifest)) {
    assert.ok(allowedAgFields.has(key), `Unexpected top-level key in Antigravity plugin.json: ${key}`);
  }
  assert.equal(agManifest.name, 'agent-token-meter');
  assert.ok(existsSync(join(REPO_ROOT, agManifest.logo)));

  // 2. Antigravity root hooks.json
  const agHooks = readJson('hooks.json');
  assert.ok(agHooks['agent-token-meter-recorder']?.Stop?.length === 1);
  assert.ok(existsSync(join(REPO_ROOT, 'hooks', 'record.mjs')));

  // 3. Claude Code manifests & hooks/hooks.json
  const ccManifest = readJson('.claude-plugin/plugin.json');
  const ccMarket = readJson('.claude-plugin/marketplace.json');
  const ccHooks = readJson('hooks/hooks.json');
  assert.equal(ccManifest.name, 'agent-token-meter');
  assert.equal(ccMarket.plugins[0].name, 'agent-token-meter');
  assert.equal(ccMarket.plugins[0].source, './');
  assert.ok(ccHooks.hooks.Stop[0].hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}'));
  assert.ok(ccHooks.hooks.SubagentStop[0].hooks[0].command.includes('${CLAUDE_PLUGIN_ROOT}'));

  // 4. Codex manifest (.codex-plugin/plugin.json)
  const codexManifest = readJson('.codex-plugin/plugin.json');
  assert.equal(codexManifest.name, 'agent-token-meter');
  assert.ok(existsSync(join(REPO_ROOT, codexManifest.skills)));
  assert.ok(existsSync(join(REPO_ROOT, codexManifest.interface.logo)));

  // 5. Antigravity sidecar manifest
  const sidecar = readJson('sidecars/dashboard/sidecar.json');
  assert.equal(sidecar.has_web_ui, true);
  assert.equal(sidecar.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
  assert.ok(existsSync(join(REPO_ROOT, 'sidecars/dashboard/main.mjs')));

  // 6. Shared skill exists and does not hardcode ~/.gemini/config/plugins/token-meter
  const skillMd = readFileSync(join(REPO_ROOT, 'skills/agent-token-meter/SKILL.md'), 'utf-8');
  assert.ok(skillMd.includes('name: agent-token-meter'));
  assert.ok(!skillMd.includes('~/.gemini/config/plugins/token-meter'));

  // 7. package.json zero runtime dependencies
  const pkg = readJson('package.json');
  assert.equal(pkg.dependencies, undefined);
  assert.ok(existsSync(join(REPO_ROOT, pkg.bin['agent-token-meter'])));
});
