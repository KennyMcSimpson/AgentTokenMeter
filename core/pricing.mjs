import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson, readJsonSafe, safeStat } from './fs-utils.mjs';
import {
  LEGACY_ANTIGRAVITY_FALLBACK,
  OFFICIAL_PRICING_RULES,
  roundRate,
  UNPRICED_RATE,
} from './rate-card.mjs';

export { LEGACY_ANTIGRAVITY_FALLBACK, OFFICIAL_PRICING_RULES, UNPRICED_RATE };

export const DEFAULT_PREFS = {
  version: 2,
  currency: 'USD',
  cnyRate: 7.25,
};

function finiteNonNeg(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getDataDir() {
  return process.env.TOKEN_METER_DATA_DIR || join(homedir(), '.agent-token-meter');
}

export function getPrefsPath(dataDir = getDataDir()) {
  return join(dataDir, 'prefs.json');
}

export function getPricingOverridePath(dataDir = getDataDir()) {
  return join(dataDir, 'pricing.override.json');
}

export function loadPrefs(dataDir = getDataDir()) {
  const path = getPrefsPath(dataDir);
  if (!existsSync(path)) return { ...DEFAULT_PREFS };
  const parsed = readJsonSafe(path, null);
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS };
  const currency = parsed.currency === 'CNY' ? 'CNY' : 'USD';
  const cnyRate = Number(parsed.cnyRate);
  return {
    version: 2,
    currency,
    cnyRate: Number.isFinite(cnyRate) && cnyRate > 0 ? cnyRate : DEFAULT_PREFS.cnyRate,
  };
}

export function prefsMtime(dataDir = getDataDir()) {
  const pStat = safeStat(getPrefsPath(dataDir));
  const oStat = safeStat(getPricingOverridePath(dataDir));
  const pKey = pStat ? `${pStat.mtimeMs}:${pStat.size}` : 'default';
  const oKey = oStat ? `${oStat.mtimeMs}:${oStat.size}` : 'none';
  return `${pKey}|ov=${oKey}`;
}

export function savePrefs(patch = {}, dataDir = getDataDir()) {
  const cur = loadPrefs(dataDir);
  const currency = patch.currency === 'CNY' ? 'CNY' : patch.currency === 'USD' ? 'USD' : cur.currency;
  const rawRate = patch.cnyRate !== undefined ? Number(patch.cnyRate) : cur.cnyRate;
  const clean = {
    version: 2,
    currency,
    cnyRate: Number.isFinite(rawRate) && rawRate > 0 ? Math.round(rawRate * 10000) / 10000 : cur.cnyRate,
  };
  atomicWriteJson(getPrefsPath(dataDir), clean);
  return clean;
}

export function loadPricingOverrides(dataDir = getDataDir()) {
  const path = getPricingOverridePath(dataDir);
  if (!existsSync(path)) return { multipliers: {}, models: {} };
  const parsed = readJsonSafe(path, null);
  if (!parsed || typeof parsed !== 'object') return { multipliers: {}, models: {} };
  return {
    multipliers: parsed.multipliers && typeof parsed.multipliers === 'object' ? parsed.multipliers : {},
    models: parsed.models && typeof parsed.models === 'object' ? parsed.models : {},
  };
}

const ROUTING_PREFIX_RE = /^(?:(?:us|eu|global)\.)?(?:anthropic|openai|google|vertex|bedrock|openrouter)[/:.]/i;

export function normalizeModel(raw) {
  if (!raw || typeof raw !== 'string') return 'unknown';
  let s = raw.trim();
  if (!s) return 'unknown';
  while (ROUTING_PREFIX_RE.test(s)) {
    s = s.replace(ROUTING_PREFIX_RE, '');
  }
  if (/^[a-z0-9._:/-]+$/.test(s)) return s;
  return (
    s
      .toLowerCase()
      .replace(/[()[\]]+/g, ' ')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

function canonicalMatchKey(slug) {
  return normalizeModel(slug).replace(/(\d)\.(\d)/g, '$1-$2');
}

const ALLOWED_SUFFIX_TOKENS = new Set([
  'xhigh',
  'high',
  'medium',
  'low',
  'minimal',
  'max',
  'thinking',
  'extended',
  'latest',
  'preview',
  'exp',
  'experimental',
  'beta',
  'alpha',
  'stable',
  'chat',
  '1m',
  '200k',
]);

/**
 * Strict official-rule suffix guard:
 * Matches exact slugs or safe release/date/effort/context/cloud suffixes
 * (`-20260514`, `-2025-08-07`, `-high`, `-preview-05-06`, `-v1:0`, `-001`, `[1m]`),
 * while rejecting unknown minor versions (`claude-opus-4.9`, `gpt-5.9`) and distinct product tiers (`o3-pro`, `gpt-5-pro`, `o3-mini`).
 */
function officialRuleMatches(key, pfx) {
  if (key === pfx) return true;
  if (!key.startsWith(pfx)) return false;
  const sep = key[pfx.length];
  if (sep !== '-' && sep !== '.' && sep !== ':') return false;
  const rest = key.slice(pfx.length + 1);
  if (!rest) return false;

  if (sep === ':' && /^\d+$/.test(rest)) return true;
  if (sep === '.') return false;

  const remaining = rest
    .replace(/(?:^|-)\d{4}-\d{2}-\d{2}(?=$|-)/g, '')
    .replace(/(?:^|-)(?:preview|exp|experimental)-\d{2}-\d{2}(?=$|-)/g, '')
    .replace(/^-|-$/g, '');

  if (!remaining) return true;

  for (const tok of remaining.split('-')) {
    if (!tok) continue;
    if (ALLOWED_SUFFIX_TOKENS.has(tok)) continue;
    if (/^\d{8}$/.test(tok)) continue;
    if (/^(?:v|rc)\d+(?::\d+)?$/.test(tok)) continue; // v1, v1:0 (Bedrock), rc2
    if (/^0\d{2}$/.test(tok)) continue; // 001, 002 (Vertex AI 3-digit revisions)
    if (/^\d{4}$/.test(tok) && Number(tok) >= 2020 && Number(tok) <= 2099) continue;
    return false;
  }
  return true;
}

function customPrefixMatches(key, pfx) {
  return key === pfx || key.startsWith(`${pfx}-`) || key.startsWith(`${pfx}.`) || key.startsWith(`${pfx}:`);
}

const EFFORT_LABELS = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  minimal: 'Minimal',
};

export function formatModelLabel(slug) {
  const s = normalizeModel(slug);
  if (s === 'unknown') return 'Unknown Model';
  const cleaned = s
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/(^|-)\d-\d(?=$|-)/g, (m) => m.replace(/(\d)-(\d)/, '$1.$2'));
  const parts = cleaned.split('-');
  let effort = '';
  if (parts.length > 1 && EFFORT_LABELS[parts[parts.length - 1]]) {
    effort = EFFORT_LABELS[parts.pop()];
  }
  const head = parts
    .map((p) => {
      if (p === 'gpt') return 'GPT';
      if (/^o\d/.test(p)) return p;
      if (/^\d/.test(p)) return p;
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' ');
  return effort ? `${head} (${effort})` : head;
}

export function inferProviderFromModel(slug) {
  const s = normalizeModel(slug);
  if (s.startsWith('gemini')) return 'google';
  if (s.startsWith('claude')) return 'anthropic';
  if (s.startsWith('gpt') || s.startsWith('codex') || /^o[1-9](?:$|[-.])/.test(s)) return 'openai';
  return 'unknown';
}

function applyMultiplier(rate, mult, noteSuffix) {
  if (!Number.isFinite(mult) || mult <= 0 || mult === 1) return rate;
  return {
    ...rate,
    input: roundRate(rate.input * mult),
    cacheRead: roundRate(rate.cacheRead * mult),
    cacheWrite5m: roundRate(rate.cacheWrite5m * mult),
    cacheWrite1h: roundRate(rate.cacheWrite1h * mult),
    output: roundRate(rate.output * mult),
    tierNote: noteSuffix ? `${rate.tierNote} (${noteSuffix})` : rate.tierNote,
  };
}

export function resolveModelRate(
  model,
  { ts = Date.now(), promptTotal = 0, agent = '', overrides = null } = {},
) {
  const key = canonicalMatchKey(model);
  const multRaw = agent && overrides?.multipliers ? Number(overrides.multipliers[agent]) : 1;
  const mult = Number.isFinite(multRaw) && multRaw > 0 ? multRaw : 1;
  const multLabel = mult !== 1 ? `×${mult}` : '';

  // 1. User custom model overrides (longest prefix match)
  if (overrides?.models && typeof overrides.models === 'object') {
    let bestCustom = null;
    for (const [rawPrefix, cfg] of Object.entries(overrides.models)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const pfx = canonicalMatchKey(rawPrefix);
      if (customPrefixMatches(key, pfx)) {
        if (!bestCustom || pfx.length > bestCustom.pfx.length) {
          bestCustom = { pfx, cfg };
        }
      }
    }
    if (bestCustom) {
      const inp = finiteNonNeg(bestCustom.cfg.input, 0);
      const cr = finiteNonNeg(bestCustom.cfg.cacheRead, inp);
      const cw5 = finiteNonNeg(bestCustom.cfg.cacheWrite5m, inp);
      const cw1h = finiteNonNeg(bestCustom.cfg.cacheWrite1h, cw5);
      const out = finiteNonNeg(bestCustom.cfg.output, 0);
      return applyMultiplier(
        {
          provider: String(bestCustom.cfg.provider || inferProviderFromModel(model) || 'custom'),
          input: inp,
          cacheRead: cr,
          cacheWrite5m: cw5,
          cacheWrite1h: cw1h,
          output: out,
          tierNote: String(bestCustom.cfg.tierNote || 'Custom rate (pricing.override.json)'),
          matchType: 'custom',
          matchedRule: bestCustom.pfx,
        },
        mult,
        multLabel,
      );
    }
  }

  // 2. Built-in official pricing catalog (strict suffix guard, longest prefix wins)
  let best = null;
  for (const rule of OFFICIAL_PRICING_RULES) {
    const pfx = canonicalMatchKey(rule.prefix);
    if (officialRuleMatches(key, pfx)) {
      if (!best || pfx.length > best.pfx.length) {
        best = { pfx, rule };
      }
    }
  }
  if (best) {
    const resolved = best.rule.resolve({ ts, promptTotal });
    return applyMultiplier(
      {
        provider: best.rule.provider,
        input: resolved.input,
        cacheRead: resolved.cacheRead,
        cacheWrite5m: resolved.cacheWrite5m ?? resolved.input,
        cacheWrite1h: resolved.cacheWrite1h ?? resolved.cacheWrite5m ?? resolved.input,
        output: resolved.output,
        tierNote: resolved.tierNote,
        matchType: 'official',
        matchedRule: best.rule.prefix,
      },
      mult,
      multLabel,
    );
  }

  // 3. Explicit legacy fallback ONLY for pre-Nov-19 Antigravity steps missing a model name
  if (agent === 'antigravity' && key === 'unknown') {
    return applyMultiplier({ ...LEGACY_ANTIGRAVITY_FALLBACK }, mult, multLabel);
  }

  // 4. Honest unpriced marker for unknown / unlisted models
  return {
    ...UNPRICED_RATE,
    provider: inferProviderFromModel(model),
  };
}

export function listOfficialRateCard(nowMs = Date.now()) {
  return OFFICIAL_PRICING_RULES.map((rule) => {
    const r = rule.resolve({ ts: nowMs, promptTotal: 0 });
    return {
      provider: rule.provider,
      prefix: rule.prefix,
      family: rule.family,
      input: r.input,
      cacheRead: r.cacheRead,
      cacheWrite5m: r.cacheWrite5m ?? r.input,
      cacheWrite1h: r.cacheWrite1h ?? r.cacheWrite5m ?? r.input,
      output: r.output,
      tierNote: r.tierNote,
    };
  });
}

export function calcCostUsd({ input = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0, output = 0 }, rate) {
  if (!rate || rate.matchType === 'unpriced') {
    return {
      inputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      outputCost: 0,
      total: 0,
      cacheSaved: 0,
      unpriced: true,
    };
  }
  const inTok = finiteNonNeg(input, 0);
  const crTok = finiteNonNeg(cacheRead, 0);
  const cw5Tok = finiteNonNeg(cacheWrite5m, 0);
  const cw1hTok = finiteNonNeg(cacheWrite1h, 0);
  const outTok = finiteNonNeg(output, 0);

  const inRate = finiteNonNeg(rate.input, 0);
  const crRate = finiteNonNeg(rate.cacheRead, inRate);
  const cw5Rate = finiteNonNeg(rate.cacheWrite5m, inRate);
  const cw1hRate = finiteNonNeg(rate.cacheWrite1h, cw5Rate);
  const outRate = finiteNonNeg(rate.output, 0);

  const inputCost = (inTok / 1e6) * inRate;
  const cacheReadCost = (crTok / 1e6) * crRate;
  const cacheWriteCost = (cw5Tok / 1e6) * cw5Rate + (cw1hTok / 1e6) * cw1hRate;
  const outputCost = (outTok / 1e6) * outRate;

  const readDiscount = (crTok / 1e6) * Math.max(0, inRate - crRate);
  const writeSurcharge =
    (cw5Tok / 1e6) * Math.max(0, cw5Rate - inRate) +
    (cw1hTok / 1e6) * Math.max(0, cw1hRate - inRate);

  return {
    inputCost,
    cacheReadCost,
    cacheWriteCost,
    outputCost,
    total: inputCost + cacheReadCost + cacheWriteCost + outputCost,
    cacheSaved: readDiscount - writeSurcharge,
    unpriced: false,
  };
}
