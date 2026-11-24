/**
 * Built-in official API rate card (USD per 1M tokens).
 *
 * Kept separate from pricing engine logic so contributors can update
 * model prices in one declarative file without touching matching/billing code.
 *
 * Sources:
 * - Google Gemini Paid-Tier Global: https://ai.google.dev/gemini-api/docs/pricing
 * - Anthropic Claude API:           https://docs.anthropic.com/en/docs/about-claude/pricing
 * - OpenAI GPT / Codex / o-series:  https://openai.com/api/pricing
 */

const DEC_1_2026_UTC = Date.UTC(2026, 11, 1, 0, 0, 0);
const JAN_1_2027_UTC = Date.UTC(2027, 0, 1, 0, 0, 0);
const LONG_CTX_272K = 272_000;
const LONG_CTX_200K = 200_000;
const LONG_CTX_100K = 100_000;

export function roundRate(v) {
  return Math.round(v * 10_000) / 10_000;
}

function claudeRates(input, output, cacheReadMult = 0.1, tierNote = 'Anthropic official (5m/1h cache write)') {
  return {
    input,
    cacheRead: roundRate(input * cacheReadMult),
    cacheWrite5m: roundRate(input * 1.25),
    cacheWrite1h: roundRate(input * 2.0),
    output,
    tierNote,
  };
}

function flatRates(input, cacheRead, output, tierNote = 'Official standard tier') {
  return {
    input,
    cacheRead,
    cacheWrite5m: input,
    cacheWrite1h: input,
    output,
    tierNote,
  };
}

function openaiTiered272k(
  input,
  cacheRead,
  output,
  cacheLabel = '90% cache discount',
  { cacheWrite30mMult = 1.25, cacheWrite12hMult = 2.5 } = {},
) {
  return ({ promptTotal }) => {
    const isLong = promptTotal > LONG_CTX_272K;
    const effIn = isLong ? roundRate(input * 2) : input;
    const effCr = isLong ? roundRate(cacheRead * 2) : cacheRead;
    const effOut = isLong ? roundRate(output * 1.5) : output;
    const cwNote = cacheWrite30mMult > 1 ? `; ${cacheWrite30mMult}x cache write` : '';
    return {
      input: effIn,
      cacheRead: effCr,
      cacheWrite5m: roundRate(effIn * cacheWrite30mMult),
      cacheWrite1h: roundRate(effIn * cacheWrite12hMult),
      output: effOut,
      tierNote: isLong
        ? `OpenAI official long-context (>272K${cacheWrite30mMult > 1 ? `; est. ${cacheWrite30mMult}x long-ctx cache write` : ''})`
        : `OpenAI official (${cacheLabel}${cwNote}; <=272K / >272K tiered)`,
    };
  };
}

export const OFFICIAL_PRICING_RULES = [
  // ======================== Google Gemini ========================
  {
    provider: 'google',
    prefix: 'gemini-4-neon',
    family: 'Gemini 4 Neon',
    resolve: () => flatRates(3.0, 0.15, 15.0, 'Google official (95% cache discount)'),
  },
  {
    provider: 'google',
    prefix: 'gemini-4-hydrogen',
    family: 'Gemini 4 Hydrogen',
    resolve: () => flatRates(1.5, 0.075, 7.5, 'Google official (95% cache discount)'),
  },
  {
    provider: 'google',
    prefix: 'gemini-4-carbon',
    family: 'Gemini 4 Carbon',
    resolve: ({ ts }) =>
      ts >= DEC_1_2026_UTC
        ? flatRates(4.0, 0.2, 20.0, 'Google official standard (from 2026-12-01)')
        : flatRates(2.0, 0.1, 10.0, 'Google official intro (through 2026-11-30)'),
  },
  {
    provider: 'google',
    prefix: 'gemini-4-argon',
    family: 'Gemini 4 Argon',
    resolve: ({ ts }) =>
      ts >= DEC_1_2026_UTC
        ? flatRates(4.0, 0.2, 20.0, 'Google official standard (from 2026-12-01)')
        : flatRates(2.0, 0.1, 10.0, 'Google official intro (through 2026-11-30)'),
  },
  {
    provider: 'google',
    prefix: 'gemini-3.8-flash',
    family: 'Gemini 3.8 Flash',
    resolve: ({ ts }) =>
      ts >= JAN_1_2027_UTC
        ? flatRates(1.5, 0.15, 7.5, 'Google official standard (from 2027-01-01)')
        : flatRates(0.75, 0.075, 3.75, 'Google official intro (through 2026-12-31)'),
  },
  {
    provider: 'google',
    prefix: 'gemini-3.1-pro',
    family: 'Gemini 3.1 Pro',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CTX_200K
        ? flatRates(4.0, 0.4, 18.0, 'Google official long-context (>200K)')
        : flatRates(2.0, 0.2, 12.0, 'Google official (<=200K / >200K tiered)'),
  },
  {
    provider: 'google',
    prefix: 'gemini-3-pro',
    family: 'Gemini 3 Pro',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CTX_200K
        ? flatRates(4.0, 0.4, 18.0, 'Google official long-context (>200K)')
        : flatRates(2.0, 0.2, 12.0, 'Google official (<=200K / >200K tiered)'),
  },
  {
    provider: 'google',
    prefix: 'gemini-3.5-flash-lite',
    family: 'Gemini 3.5 Flash-Lite',
    resolve: () => flatRates(0.25, 0.025, 1.5, 'Google official standard'),
  },
  {
    provider: 'google',
    prefix: 'gemini-3.1-flash-lite',
    family: 'Gemini 3.1 Flash-Lite',
    resolve: () => flatRates(0.25, 0.025, 1.5, 'Google official standard'),
  },
  {
    provider: 'google',
    prefix: 'gemini-3-flash',
    family: 'Gemini 3 Flash',
    resolve: () => flatRates(0.5, 0.05, 3.0, 'Google official standard'),
  },
  {
    provider: 'google',
    prefix: 'gemini-2.5-pro',
    family: 'Gemini 2.5 Pro',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CTX_200K
        ? flatRates(2.5, 0.25, 15.0, 'Google official long-context (>200K)')
        : flatRates(1.25, 0.125, 10.0, 'Google official (<=200K / >200K tiered)'),
  },
  {
    provider: 'google',
    prefix: 'gemini-2.5-flash-lite',
    family: 'Gemini 2.5 Flash-Lite',
    resolve: () => flatRates(0.1, 0.01, 0.4, 'Google official standard'),
  },
  {
    provider: 'google',
    prefix: 'gemini-2.5-flash',
    family: 'Gemini 2.5 Flash',
    resolve: () => flatRates(0.3, 0.03, 2.5, 'Google official standard'),
  },

  // ======================== Anthropic Claude ========================
  {
    provider: 'anthropic',
    prefix: 'claude-fable-5-2',
    family: 'Claude Fable 5.2',
    resolve: () => claudeRates(8.0, 40.0, 0.025, 'Anthropic official (97.5% cache read)'),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-fable-5-1',
    family: 'Claude Fable 5.1',
    resolve: () => claudeRates(10.0, 50.0, 0.025, 'Anthropic official (97.5% cache read)'),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-opus-5-5',
    family: 'Claude Opus 5.5',
    resolve: () => claudeRates(4.0, 20.0, 0.05, 'Anthropic official (95% cache read)'),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-opus-5',
    family: 'Claude Opus 5',
    resolve: () => claudeRates(5.0, 25.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-sonnet-5-5',
    family: 'Claude Sonnet 5.5',
    resolve: () => claudeRates(2.0, 10.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-sonnet-5',
    family: 'Claude Sonnet 5',
    resolve: () => claudeRates(2.0, 10.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-haiku-5-5',
    family: 'Claude Haiku 5.5',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CTX_100K
        ? claudeRates(0.5, 2.5, 0.1, 'Anthropic official long-context (>100K)')
        : claudeRates(0.1, 0.5, 0.1, 'Anthropic official (<=100K / >100K tiered)'),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-opus-4-8',
    family: 'Claude Opus 4.8',
    resolve: () => claudeRates(5.0, 25.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-opus-4-7',
    family: 'Claude Opus 4.7',
    resolve: () => claudeRates(5.0, 25.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-opus-4-6',
    family: 'Claude Opus 4.6',
    resolve: () => claudeRates(5.0, 25.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-opus-4-5',
    family: 'Claude Opus 4.5',
    resolve: () => claudeRates(5.0, 25.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-opus-4-1',
    family: 'Claude Opus 4.1',
    resolve: () => claudeRates(15.0, 75.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-opus-4',
    family: 'Claude Opus 4',
    resolve: () => claudeRates(15.0, 75.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-sonnet-4-6',
    family: 'Claude Sonnet 4.6',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CTX_200K
        ? claudeRates(6.0, 22.5, 0.1, 'Anthropic official long-context (>200K)')
        : claudeRates(3.0, 15.0, 0.1, 'Anthropic official (<=200K / >200K tiered)'),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-sonnet-4-5',
    family: 'Claude Sonnet 4.5',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CTX_200K
        ? claudeRates(6.0, 22.5, 0.1, 'Anthropic official long-context (>200K)')
        : claudeRates(3.0, 15.0, 0.1, 'Anthropic official (<=200K / >200K tiered)'),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-sonnet-4',
    family: 'Claude Sonnet 4',
    resolve: ({ promptTotal }) =>
      promptTotal > LONG_CTX_200K
        ? claudeRates(6.0, 22.5, 0.1, 'Anthropic official long-context (>200K)')
        : claudeRates(3.0, 15.0, 0.1, 'Anthropic official (<=200K / >200K tiered)'),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-haiku-4-5',
    family: 'Claude Haiku 4.5',
    resolve: () => claudeRates(1.0, 5.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-3-7-sonnet',
    family: 'Claude 3.7 Sonnet',
    resolve: () => claudeRates(3.0, 15.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-3-5-sonnet',
    family: 'Claude 3.5 Sonnet',
    resolve: () => claudeRates(3.0, 15.0, 0.1),
  },
  {
    provider: 'anthropic',
    prefix: 'claude-3-5-haiku',
    family: 'Claude 3.5 Haiku',
    resolve: () => claudeRates(0.8, 4.0, 0.1),
  },

  // ======================== OpenAI GPT / Codex / o-series ========================
  {
    provider: 'openai',
    prefix: 'gpt-6.2-astra',
    family: 'GPT-6.2 Astra',
    resolve: openaiTiered272k(8.0, 0.4, 40.0, '95% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-6-astra',
    family: 'GPT-6 Astra',
    resolve: openaiTiered272k(10.0, 1.0, 50.0, '90% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-6.2-sol',
    family: 'GPT-6.2 Sol',
    resolve: openaiTiered272k(2.0, 0.1, 10.0, '95% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-6.1-sol',
    family: 'GPT-6.1 Sol',
    resolve: openaiTiered272k(2.0, 0.1, 10.0, '95% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-6-sol',
    family: 'GPT-6 Sol',
    resolve: openaiTiered272k(2.0, 0.2, 10.0, '90% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-6.1-terra',
    family: 'GPT-6.1 Terra',
    resolve: openaiTiered272k(1.0, 0.05, 5.0, '95% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-6-luna',
    family: 'GPT-6 Luna',
    resolve: openaiTiered272k(0.1, 0.01, 0.5, '90% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.6-sol',
    family: 'GPT-5.6 Sol',
    resolve: openaiTiered272k(4.0, 0.4, 20.0, '90% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.6-terra',
    family: 'GPT-5.6 Terra',
    resolve: openaiTiered272k(2.0, 0.2, 12.0, '90% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.6-luna',
    family: 'GPT-5.6 Luna',
    resolve: openaiTiered272k(0.2, 0.02, 1.2, '90% cache discount'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.5',
    family: 'GPT-5.5',
    resolve: openaiTiered272k(5.0, 0.5, 30.0, '90% cache discount', {
      cacheWrite30mMult: 1.0,
      cacheWrite12hMult: 1.0,
    }),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.4',
    family: 'GPT-5.4',
    resolve: openaiTiered272k(2.5, 0.25, 15.0, '90% cache discount', {
      cacheWrite30mMult: 1.0,
      cacheWrite12hMult: 1.0,
    }),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.3-codex',
    family: 'GPT-5.3 Codex',
    resolve: () => flatRates(1.75, 0.18, 14.0, 'OpenAI Codex official'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.2-pro',
    family: 'GPT-5.2 Pro',
    resolve: () => flatRates(21.0, 21.0, 168.0, 'OpenAI official Pro'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.2-codex',
    family: 'GPT-5.2 Codex',
    resolve: () => flatRates(1.75, 0.175, 14.0, 'OpenAI Codex official'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.2',
    family: 'GPT-5.2',
    resolve: () => flatRates(1.75, 0.175, 14.0, 'OpenAI official (90% cache discount)'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.1-codex-mini',
    family: 'GPT-5.1 Codex Mini',
    resolve: () => flatRates(0.25, 0.025, 2.0, 'OpenAI Codex Mini official'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.1-codex',
    family: 'GPT-5.1 Codex',
    resolve: () => flatRates(1.25, 0.125, 10.0, 'OpenAI Codex official'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5.1',
    family: 'GPT-5.1',
    resolve: () => flatRates(1.25, 0.125, 10.0, 'OpenAI official (90% cache discount)'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5-codex',
    family: 'GPT-5 Codex',
    resolve: () => flatRates(1.25, 0.125, 10.0, 'OpenAI Codex official'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5-mini',
    family: 'GPT-5 Mini',
    resolve: () => flatRates(0.25, 0.025, 2.0, 'OpenAI official (90% cache discount)'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5-nano',
    family: 'GPT-5 Nano',
    resolve: () => flatRates(0.05, 0.005, 0.4, 'OpenAI official (90% cache discount)'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-5',
    family: 'GPT-5',
    resolve: () => flatRates(1.25, 0.125, 10.0, 'OpenAI official (90% cache discount)'),
  },
  {
    provider: 'openai',
    prefix: 'codex-mini-latest',
    family: 'Codex Mini',
    resolve: () => flatRates(1.5, 0.375, 6.0, 'OpenAI Codex Mini official'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-4.1-mini',
    family: 'GPT-4.1 Mini',
    resolve: () => flatRates(0.4, 0.1, 1.6, 'OpenAI official standard'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-4.1-nano',
    family: 'GPT-4.1 Nano',
    resolve: () => flatRates(0.1, 0.025, 0.4, 'OpenAI official standard'),
  },
  {
    provider: 'openai',
    prefix: 'gpt-4.1',
    family: 'GPT-4.1',
    resolve: () => flatRates(2.0, 0.5, 8.0, 'OpenAI official standard'),
  },
  {
    provider: 'openai',
    prefix: 'o3',
    family: 'OpenAI o3',
    resolve: () => flatRates(2.0, 0.5, 8.0, 'OpenAI official reasoning'),
  },
  {
    provider: 'openai',
    prefix: 'o4-mini',
    family: 'OpenAI o4-mini',
    resolve: () => flatRates(1.1, 0.275, 4.4, 'OpenAI official reasoning'),
  },
];

// Used ONLY for pre-Nov-19 legacy Antigravity steps with unrecoverable model name.
export const LEGACY_ANTIGRAVITY_FALLBACK = {
  provider: 'google',
  ...flatRates(2.0, 0.1, 10.0, 'Legacy Antigravity transcript without model field (Gemini 4 estimate)'),
  matchType: 'legacy_estimate',
  matchedRule: 'legacy-antigravity',
};

export const UNPRICED_RATE = {
  provider: 'unknown',
  input: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  output: 0,
  tierNote: 'Unlisted model (not billed; add custom rates in pricing.override.json)',
  matchType: 'unpriced',
  matchedRule: 'unpriced',
};
