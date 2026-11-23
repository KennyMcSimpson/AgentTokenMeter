import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  calcCostUsd,
  formatModelLabel,
  getPricingOverridePath,
  loadPricingOverrides,
  normalizeModel,
  resolveModelRate,
} from '../core/pricing.mjs';
import { buildReport } from '../core/report.mjs';
import { syncAllSources } from '../core/sync.mjs';
import { createTestEnv } from './helpers.mjs';

test('Google Gemini pricing: intro-to-standard date transitions and >200K long-context tiers', () => {
  const beforeDec = Date.UTC(2026, 10, 30, 23, 59, 59);
  const onDec1 = Date.UTC(2026, 11, 1, 0, 0, 0);

  const carbonIntro = resolveModelRate('gemini-4-carbon-high', { ts: beforeDec });
  assert.equal(carbonIntro.provider, 'google');
  assert.equal(carbonIntro.matchType, 'official');
  assert.equal(carbonIntro.input, 2.0);
  assert.equal(carbonIntro.cacheRead, 0.1);
  assert.equal(carbonIntro.output, 10.0);

  const carbonStd = resolveModelRate('gemini-4-carbon-high', { ts: onDec1 });
  assert.equal(carbonStd.input, 4.0);
  assert.equal(carbonStd.cacheRead, 0.2);
  assert.equal(carbonStd.output, 20.0);

  const flash38Before = resolveModelRate('gemini-3.8-flash', { ts: Date.UTC(2026, 11, 31, 23, 59, 59) });
  const flash38After = resolveModelRate('gemini-3.8-flash', { ts: Date.UTC(2027, 0, 1, 0, 0, 0) });
  assert.equal(flash38Before.input, 0.75);
  assert.equal(flash38After.input, 1.5);

  const proShort = resolveModelRate('gemini-2.5-pro', { promptTotal: 200_000 });
  const proLong = resolveModelRate('gemini-2.5-pro', { promptTotal: 200_001 });
  assert.equal(proShort.input, 1.25);
  assert.equal(proLong.input, 2.5);
  assert.equal(proLong.output, 15.0);
});

test('Anthropic Claude pricing: dot/hyphen/date/prefix normalization, 5m vs 1h cache write, and net cache savings', () => {
  const opus46 = resolveModelRate('anthropic/claude-opus-4.6');
  assert.equal(opus46.provider, 'anthropic');
  assert.equal(opus46.matchType, 'official');
  assert.equal(opus46.input, 5.0);
  assert.equal(opus46.cacheRead, 0.5);
  assert.equal(opus46.cacheWrite5m, 6.25);
  assert.equal(opus46.cacheWrite1h, 10.0);
  assert.equal(opus46.output, 25.0);

  const sonnetDated = resolveModelRate('claude-sonnet-4-6-20260514', { promptTotal: 250_000 });
  assert.equal(sonnetDated.input, 6.0);
  assert.equal(sonnetDated.cacheWrite5m, 7.5);
  assert.equal(sonnetDated.cacheWrite1h, 12.0);
  assert.equal(sonnetDated.output, 22.5);

  const haiku55Low = resolveModelRate('claude-haiku-5.5', { promptTotal: 50_000 });
  const haiku55High = resolveModelRate('claude-haiku-5-5', { promptTotal: 150_000 });
  assert.equal(haiku55Low.input, 0.1);
  assert.equal(haiku55High.input, 0.5);

  // Verify exact 5m + 1h cache write billing and net savings calculation
  const cost = calcCostUsd(
    { input: 1_000_000, cacheRead: 2_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, output: 1_000_000 },
    opus46,
  );
  // input $5 + cacheRead $1 + cw5 $6.25 + cw1h $10 + output $25 = $47.25
  assert.equal(Number(cost.total.toFixed(4)), 47.25);
  // readDiscount: 2M * (5 - 0.5) = $9; writeSurcharge: 1M*1.25 + 1M*5 = $6.25 -> net saved = $2.75
  assert.equal(Number(cost.cacheSaved.toFixed(4)), 2.75);
});

test('OpenAI / Codex pricing, honest unpriced marking, legacy AG fallback, and user overrides', () => {
  const codex53 = resolveModelRate('openai/gpt-5.3-codex');
  assert.equal(codex53.provider, 'openai');
  assert.equal(codex53.input, 1.75);
  assert.equal(codex53.cacheRead, 0.18);
  assert.equal(codex53.output, 14.0);

  const luna = resolveModelRate('gpt-6-luna');
  assert.equal(luna.input, 0.1);
  assert.equal(luna.output, 0.5);

  // Unknown model for Claude/Codex MUST be marked unpriced (never silently priced as Gemini!)
  const unlisted = resolveModelRate('mystery-model-99', { agent: 'codex' });
  assert.equal(unlisted.matchType, 'unpriced');
  const unlistedCost = calcCostUsd({ input: 1_000_000, output: 1_000_000 }, unlisted);
  assert.equal(unlistedCost.unpriced, true);
  assert.equal(unlistedCost.total, 0);

  // Legacy AG unknown model explicitly stays legacy_estimate
  const legacyAg = resolveModelRate('unknown', { agent: 'antigravity' });
  assert.equal(legacyAg.matchType, 'legacy_estimate');
  assert.equal(legacyAg.input, 2.0);

  // Custom override file + channel multiplier
  const env = createTestEnv('atm-pricing-');
  try {
    writeFileSync(
      getPricingOverridePath(env.dataDir),
      JSON.stringify({
        multipliers: { 'claude-code': 0.5 },
        models: {
          'my-local-model': {
            provider: 'custom',
            input: 2.0,
            cacheRead: 0.2,
            cacheWrite5m: 2.5,
            cacheWrite1h: 4.0,
            output: 10.0,
          },
        },
      }),
      'utf-8',
    );
    const overrides = loadPricingOverrides(env.dataDir);
    const custom = resolveModelRate('my-local-model-v2', { agent: 'claude-code', overrides });
    assert.equal(custom.matchType, 'custom');
    assert.equal(custom.input, 1.0);
    assert.equal(custom.output, 5.0);
  } finally {
    env.cleanup();
  }
});

test('Model normalization, strict suffix guard, nested routing prefixes, and label formatting', () => {
  assert.equal(normalizeModel('anthropic/claude-opus-4-6-20260205'), 'claude-opus-4-6-20260205');
  assert.equal(normalizeModel('openrouter/anthropic/claude-opus-4-6'), 'claude-opus-4-6');
  assert.equal(normalizeModel('Gemini 4 Neon (XHigh)'), 'gemini-4-neon-xhigh');
  assert.equal(formatModelLabel('claude-opus-4-6-20260205'), 'Claude Opus 4.6');
  assert.equal(formatModelLabel('claude-3-5-sonnet-20241022'), 'Claude 3.5 Sonnet');
  assert.equal(formatModelLabel('gemini-4-neon-xhigh'), 'Gemini 4 Neon (XHigh)');

  // Nested gateway prefix matches official rate
  const nested = resolveModelRate('openrouter/anthropic/claude-opus-4-6');
  assert.equal(nested.matchType, 'official');
  assert.equal(nested.input, 5.0);

  // Unknown minor versions and distinct product tiers MUST NOT misprice via shorter prefix
  for (const unlisted of [
    'claude-opus-4.9',
    'claude-opus-4-2',
    'claude-sonnet-5.9',
    'gpt-5.9',
    'gpt-5.5-pro',
    'gpt-5.3',
    'gpt-5-pro',
    'gpt-5.4-pro',
    'o3-pro',
    'o3-mini',
  ]) {
    const r = resolveModelRate(unlisted, { agent: 'claude-code' });
    assert.equal(r.matchType, 'unpriced', `Expected ${unlisted} to be unpriced, got ${r.matchedRule}`);
  }

  // Legitimate dated/effort/preview/Bedrock/1M/Vertex suffixes still match official rates
  for (const valid of [
    'gpt-5-2025-08-07',
    'o3-2025-04-16',
    'gemini-2.5-pro-preview-05-06',
    'us.anthropic.claude-opus-4-6-v1:0',
    'bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0',
    'claude-opus-4-6[1m]',
    'claude-sonnet-4-6[1m]',
    'gemini-2.5-pro-001',
    'gemini-2.5-flash-002',
  ]) {
    assert.equal(resolveModelRate(valid).matchType, 'official', `Expected ${valid} to match official rate`);
  }
});

test('pricing.override.json malformed non-numeric values never poison costs with NaN', () => {
  const env = createTestEnv('atm-override-nan-');
  try {
    writeFileSync(
      getPricingOverridePath(env.dataDir),
      JSON.stringify({
        models: {
          'weird-model': {
            provider: 'custom',
            input: 2.0,
            cacheRead: 'bad-string',
            cacheWrite5m: null,
            cacheWrite1h: 'oops',
            output: 8.0,
          },
        },
      }),
      'utf-8',
    );
    const overrides = loadPricingOverrides(env.dataDir);
    const rate = resolveModelRate('weird-model', { overrides });
    assert.equal(Number.isFinite(rate.cacheRead), true);
    assert.equal(Number.isFinite(rate.cacheWrite5m), true);
    assert.equal(Number.isFinite(rate.cacheWrite1h), true);
    const cost = calcCostUsd(
      { input: 100_000, cacheRead: 200_000, cacheWrite5m: 50_000, cacheWrite1h: 50_000, output: 10_000 },
      rate,
    );
    assert.equal(Number.isFinite(cost.total), true);
    assert.equal(Number.isFinite(cost.cacheSaved), true);
  } finally {
    env.cleanup();
  }
});

test('OpenAI GPT-6 / GPT-5.6 / GPT-5.5 official rates and >272K long-context tiering', () => {
  const cases = [
    ['gpt-6.2-astra', 8.0, 0.4, 40.0],
    ['gpt-6-astra', 10.0, 1.0, 50.0],
    ['gpt-6.2-sol', 2.0, 0.1, 10.0],
    ['gpt-6.1-sol', 2.0, 0.1, 10.0],
    ['gpt-6-sol', 2.0, 0.1, 10.0],
    ['gpt-6.1-terra', 1.0, 0.05, 5.0],
    ['gpt-6-luna', 0.1, 0.01, 0.5],
    ['gpt-5.6-sol', 4.0, 0.4, 20.0],
    ['gpt-5.6-terra', 2.0, 0.2, 12.0],
    ['gpt-5.6-luna', 0.2, 0.02, 1.2],
    ['gpt-5.5', 5.0, 0.5, 30.0],
    ['gpt-5.4', 2.5, 0.25, 15.0],
  ];

  for (const [model, inp, cr, out] of cases) {
    const std = resolveModelRate(model, { promptTotal: 272_000 });
    assert.equal(std.matchType, 'official', `${model} should match official`);
    assert.equal(std.provider, 'openai');
    assert.equal(std.input, inp, `${model} standard input`);
    assert.equal(std.cacheRead, cr, `${model} standard cacheRead`);
    assert.equal(std.output, out, `${model} standard output`);

    const longCtx = resolveModelRate(model, { promptTotal: 272_001 });
    assert.equal(longCtx.input, Math.round(inp * 2 * 10_000) / 10_000, `${model} >272K input`);
    assert.equal(longCtx.cacheRead, Math.round(cr * 2 * 10_000) / 10_000, `${model} >272K cacheRead`);
    assert.equal(longCtx.output, Math.round(out * 1.5 * 10_000) / 10_000, `${model} >272K output`);
  }

  // Verify end-to-end report pricing uses inclusive promptTotal (in + cr + cw5) for >272K check
  const h = createTestEnv('atm-272k-');
  try {
    const rollout = h.mkCodexRollout(
      '2026/11/23',
      'rollout-2026-11-23T09-00-00-44444444-4444-4444-4444-444444444444.jsonl',
    );
    writeFileSync(
      rollout,
      [
        JSON.stringify({
          timestamp: '2026-11-23T09:00:00Z',
          type: 'session_meta',
          payload: { id: '44444444-4444-4444-4444-444444444444' },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T09:00:01Z',
          type: 'turn_context',
          payload: { model: 'gpt-6.1-sol' },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T09:00:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              // Inclusive input = 280,000 (>272K) -> uncached 30k @ $4/M + cached 250k @ $0.20/M + output 10k @ $15/M
              total_token_usage: { input_tokens: 280_000, cached_input_tokens: 250_000, output_tokens: 10_000 },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    syncAllSources({ dataDir: h.dataDir });
    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    // Expected: 0.03 * 4 + 0.25 * 0.2 + 0.01 * 15 = 0.12 + 0.05 + 0.15 = $0.32
    assert.equal(Number(rep.period.costUsd.toFixed(6)), 0.32);
  } finally {
    h.cleanup();
  }
});
