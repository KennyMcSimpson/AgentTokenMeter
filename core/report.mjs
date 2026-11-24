import { AGENT_IDS, AGENT_LABELS, getEnabledAgentIds, normalizeAgentId } from '../adapters/index.mjs';
import {
  calcCostUsd,
  formatModelLabel,
  getDataDir,
  listOfficialRateCard,
  loadPrefs,
  loadPricingOverrides,
  normalizeModel,
  resolveModelRate,
} from './pricing.mjs';
import { loadLedger, sessionKey } from './store.mjs';

const MAX_RANGE_DAYS = 3650;
const MAX_TZ_CACHE_ZONES = 64;
const MAX_TZ_HOUR_SLOTS = 8192;
const tzFormatterCache = new Map();
const tzHourCache = new Map();

export function resolveTimeZone(tz) {
  const candidate =
    typeof tz === 'string' && tz.trim()
      ? tz.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
}

export function localDateKey(tsMs, timeZone = resolveTimeZone()) {
  let fmt = tzFormatterCache.get(timeZone);
  if (!fmt) {
    if (tzFormatterCache.size >= MAX_TZ_CACHE_ZONES) {
      tzFormatterCache.clear();
      tzHourCache.clear();
    }
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    tzFormatterCache.set(timeZone, fmt);
  }
  if (!Number.isInteger(tsMs) || tsMs < 0 || tsMs > 8.63e15) {
    return fmt.format(tsMs);
  }
  let hourMap = tzHourCache.get(timeZone);
  if (!hourMap) {
    hourMap = new Map();
    tzHourCache.set(timeZone, hourMap);
  }
  const hourSlot = Math.floor(tsMs / 3_600_000);
  if (hourMap.has(hourSlot)) {
    const cached = hourMap.get(hourSlot);
    return cached !== null ? cached : fmt.format(tsMs);
  }
  // Probe start, midpoint (+30m), and end (+59m59.999s) of the UTC hour.
  // Because no IANA DST shift is < 30m, equal dates at all three points guarantee
  // a constant local calendar date for every integer millisecond in this hour.
  const slotStart = hourSlot * 3_600_000;
  const d0 = fmt.format(slotStart);
  const d1 = fmt.format(slotStart + 1_800_000);
  const d2 = fmt.format(slotStart + 3_599_999);
  const constant = d0 === d1 && d1 === d2 ? d0 : null;
  if (hourMap.size >= MAX_TZ_HOUR_SLOTS) {
    hourMap.clear();
  }
  hourMap.set(hourSlot, constant);
  return constant !== null ? constant : fmt.format(tsMs);
}

function addDaysUtcDateStr(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function diffDaysUtcDateStr(startStr, endStr) {
  const [y1, m1, d1] = startStr.split('-').map(Number);
  const [y2, m2, d2] = endStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

function emptyBucket() {
  return {
    steps: 0,
    unpricedSteps: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    costUsd: 0,
    inputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
    outputCostUsd: 0,
    cacheSavedUsd: 0,
  };
}

function accumulate(bucket, e, cost) {
  const cw = e.cw5 + e.cw1h;
  bucket.steps += 1;
  if (cost.unpriced) bucket.unpricedSteps += 1;
  bucket.input += e.in;
  bucket.cacheRead += e.cr;
  bucket.cacheWrite5m += e.cw5;
  bucket.cacheWrite1h += e.cw1h;
  bucket.cacheWrite += cw;
  bucket.output += e.out;
  bucket.reasoning += e.r;
  // Disjoint total (reasoning is a subset of output, never double-counted)
  bucket.total += e.in + e.cr + cw + e.out;
  bucket.costUsd += cost.total;
  bucket.inputCostUsd += cost.inputCost;
  bucket.cacheReadCostUsd += cost.cacheReadCost;
  bucket.cacheWriteCostUsd += cost.cacheWriteCost;
  bucket.outputCostUsd += cost.outputCost;
  bucket.cacheSavedUsd += cost.cacheSaved;
}

function finalizeBucket(bucket) {
  const promptTotal = bucket.input + bucket.cacheRead + bucket.cacheWrite;
  return {
    ...bucket,
    promptTotal,
    cacheHitRate: promptTotal > 0 ? bucket.cacheRead / promptTotal : 0,
  };
}

export function normalizeAgentFilter(raw) {
  return normalizeAgentId(raw) || 'all';
}

export function buildReport({
  dataDir = getDataDir(),
  rangeDays = 7,
  timeZone,
  agent = 'all',
  allowedAgents = null,
  activeSessionId = '',
  prefs = loadPrefs(dataDir),
  months = null,
} = {}) {
  const { events, sessions, fingerprint } = loadLedger(dataDir, { months });
  const overrides = loadPricingOverrides(dataDir);
  const now = Date.now();
  const resolvedTz = resolveTimeZone(timeZone);
  const todayStr = localDateKey(now, resolvedTz);

  const rawAllowed = Array.isArray(allowedAgents) && allowedAgents.length > 0 ? allowedAgents : getEnabledAgentIds();
  const allowedList = [];
  const allowedSet = new Set();
  for (const id of rawAllowed) {
    const norm = normalizeAgentId(id);
    if (norm && !allowedSet.has(norm)) {
      allowedSet.add(norm);
      allowedList.push(norm);
    }
  }
  if (allowedList.length === 0) {
    for (const id of AGENT_IDS) {
      allowedSet.add(id);
      allowedList.push(id);
    }
  }

  let agentFilter = normalizeAgentFilter(agent);
  if (allowedList.length === 1) {
    agentFilter = allowedList[0];
  } else if (agentFilter !== 'all' && !allowedSet.has(agentFilter)) {
    agentFilter = 'all';
  }

  const parsedRange = Number(rangeDays);
  const days =
    Number.isFinite(parsedRange) && parsedRange >= 0 ? Math.min(Math.floor(parsedRange), MAX_RANGE_DAYS) : 7;
  const startDateStr = days > 0 ? addDaysUtcDateStr(todayStr, -(days - 1)) : '';

  const allTimeAcc = emptyBucket();
  const todayAcc = emptyBucket();
  const periodAcc = emptyBucket();
  const activeAccByAgent = new Map();

  const dailyMap = new Map();
  const modelMap = new Map();
  const sessionMap = new Map();

  // Compute per-agent period breakdown strictly within allowedAgents
  const agentMap = new Map();
  for (const id of allowedList) {
    agentMap.set(id, {
      agent: id,
      label: AGENT_LABELS[id] || id,
      ...emptyBucket(),
      sessionIds: new Set(),
    });
  }

  // Inherit session/parent model for unknown events:
  // - Codex: backfill pre-`turn_context` unknown events using the session's `firstModel`
  //   (falling back to `lastModel` only for older cursors that predate `firstModel`)
  // - Antigravity: inherit parent model for legacy pre-Nov-19 subagents via `parentSessionId` chain
  const inheritedModelCache = new Map();
  const resolveEventModel = (evAgent, sid, rawModel) => {
    const norm = normalizeModel(rawModel);
    if (norm !== 'unknown') return norm;
    if (evAgent === 'codex') {
      const cacheKey = sessionKey(evAgent, sid);
      if (inheritedModelCache.has(cacheKey)) return inheritedModelCache.get(cacheKey);
      const sMeta = sessions[cacheKey];
      const fm = normalizeModel(sMeta?.firstModel);
      const resolved = fm !== 'unknown' ? fm : normalizeModel(sMeta?.lastModel);
      inheritedModelCache.set(cacheKey, resolved);
      return resolved;
    }
    if (evAgent !== 'antigravity') return norm;
    const cacheKey = sessionKey(evAgent, sid);
    if (inheritedModelCache.has(cacheKey)) return inheritedModelCache.get(cacheKey);
    const selfFirst = normalizeModel(sessions[cacheKey]?.firstModel);
    if (selfFirst !== 'unknown') {
      inheritedModelCache.set(cacheKey, selfFirst);
      return selfFirst;
    }
    let cur = sid;
    const visited = new Set([sid]);
    let found = 'unknown';
    while (cur) {
      const meta = sessions[sessionKey(evAgent, cur)];
      const parent = meta?.parentSessionId;
      if (!parent || visited.has(parent)) break;
      visited.add(parent);
      const pMeta = sessions[sessionKey(evAgent, parent)];
      const pm = normalizeModel(pMeta?.lastModel || pMeta?.firstModel);
      if (pm !== 'unknown') {
        found = pm;
        break;
      }
      cur = parent;
    }
    inheritedModelCache.set(cacheKey, found);
    return found;
  };

  let allTimeFilteredEvents = 0;
  const allTimeFilteredSessions = new Set();
  const availableAgentSet = new Set();

  for (const e of events) {
    if (!allowedSet.has(e.a)) continue;
    availableAgentSet.add(e.a);
    const dateStr = localDateKey(e.ts, resolvedTz);
    // For bounded windows (`days > 0`), exclude future-dated events so `period` and `daily` always reconcile
    const inPeriod = days === 0 || (dateStr >= startDateStr && dateStr <= todayStr);
    const matchesAgent = agentFilter === 'all' || e.a === agentFilter;
    // Skip pricing work for events that affect neither the selected agent nor the per-agent period breakdown
    if (!inPeriod && !matchesAgent) continue;

    const model = resolveEventModel(e.a, e.c, e.m);
    const promptTotal = e.in + e.cr + e.cw5 + e.cw1h;
    const rate = resolveModelRate(model, {
      ts: e.ts,
      promptTotal,
      agent: e.a,
      serviceTier: e.st || '',
      inferenceGeo: e.geo || '',
      overrides,
    });
    const cost = calcCostUsd(
      { input: e.in, cacheRead: e.cr, cacheWrite5m: e.cw5, cacheWrite1h: e.cw1h, output: e.out },
      rate,
    );

    if (inPeriod) {
      let aEntry = agentMap.get(e.a);
      if (!aEntry) {
        aEntry = {
          agent: e.a,
          label: AGENT_LABELS[e.a] || e.a,
          ...emptyBucket(),
          sessionIds: new Set(),
        };
        agentMap.set(e.a, aEntry);
      }
      accumulate(aEntry, e, cost);
      aEntry.sessionIds.add(e.c);
    }

    if (!matchesAgent) continue;

    allTimeFilteredEvents += 1;
    allTimeFilteredSessions.add(sessionKey(e.a, e.c));
    accumulate(allTimeAcc, e, cost);

    if (dateStr === todayStr) {
      accumulate(todayAcc, e, cost);
    }
    if (activeSessionId && e.c === activeSessionId) {
      let activeAcc = activeAccByAgent.get(e.a);
      if (!activeAcc) {
        activeAcc = emptyBucket();
        activeAccByAgent.set(e.a, activeAcc);
      }
      accumulate(activeAcc, e, cost);
    }

    if (!inPeriod) continue;

    accumulate(periodAcc, e, cost);

    // Daily bucket
    let dayEntry = dailyMap.get(dateStr);
    if (!dayEntry) {
      dayEntry = { date: dateStr, ...emptyBucket() };
      dailyMap.set(dateStr, dayEntry);
    }
    accumulate(dayEntry, e, cost);

    // Model bucket
    const modelBucketKey = `${rate.provider}:${model}`;
    let mEntry = modelMap.get(modelBucketKey);
    if (!mEntry) {
      const rateAgent = agentFilter !== 'all' ? agentFilter : e.a;
      const displayRate = resolveModelRate(model, { ts: now, promptTotal: 0, agent: rateAgent, overrides });
      mEntry = {
        model,
        label: formatModelLabel(model),
        provider: displayRate.provider,
        agents: new Set(),
        ...emptyBucket(),
        rate: {
          input: displayRate.input,
          cacheRead: displayRate.cacheRead,
          cacheWrite5m: displayRate.cacheWrite5m,
          cacheWrite1h: displayRate.cacheWrite1h,
          output: displayRate.output,
        },
        tierNote: displayRate.tierNote,
        matchType: displayRate.matchType,
        matchedRule: displayRate.matchedRule,
        fastSteps: 0,
        flexSteps: 0,
      };
      modelMap.set(modelBucketKey, mEntry);
    }
    mEntry.agents.add(e.a);
    if (rate.matchType === 'official') {
      if (e.st === 'fast' && (rate.provider === 'openai' || rate.provider === 'anthropic')) {
        mEntry.fastSteps += 1;
      } else if (e.st === 'flex' && rate.provider === 'openai') {
        mEntry.flexSteps += 1;
      }
    }
    accumulate(mEntry, e, cost);

    // Session bucket
    const sk = sessionKey(e.a, e.c);
    let sEntry = sessionMap.get(sk);
    if (!sEntry) {
      const meta = sessions[sk] || {};
      sEntry = {
        agent: e.a,
        agentLabel: AGENT_LABELS[e.a] || e.a,
        sessionId: e.c,
        convId: e.c,
        title: meta.title || '',
        app: meta.app || e.a,
        firstTs: e.ts,
        lastTs: e.ts,
        ...emptyBucket(),
        modelCounts: {},
      };
      sessionMap.set(sk, sEntry);
    }
    accumulate(sEntry, e, cost);
    if (e.ts < sEntry.firstTs) sEntry.firstTs = e.ts;
    if (e.ts > sEntry.lastTs) sEntry.lastTs = e.ts;
    sEntry.modelCounts[model] = (sEntry.modelCounts[model] || 0) + 1;
  }

  // Daily series: continuous for <= 365-day spans; active dates only for wider spans (never OOM/DoS)
  const daily = [];
  if (days > 0 && days <= 365) {
    for (let i = 0; i < days; i++) {
      const d = addDaysUtcDateStr(startDateStr, i);
      const raw = dailyMap.get(d);
      daily.push(raw ? finalizeBucket(raw) : { date: d, ...finalizeBucket(emptyBucket()) });
    }
  } else {
    const sortedDates = Array.from(dailyMap.keys()).sort();
    if (sortedDates.length > 0) {
      const first = sortedDates[0];
      const end = sortedDates[sortedDates.length - 1] > todayStr ? sortedDates[sortedDates.length - 1] : todayStr;
      const span = diffDaysUtcDateStr(first, end);
      if (span <= 365) {
        let cur = first;
        while (cur <= end) {
          const raw = dailyMap.get(cur);
          daily.push(raw ? finalizeBucket(raw) : { date: cur, ...finalizeBucket(emptyBucket()) });
          cur = addDaysUtcDateStr(cur, 1);
        }
      } else {
        for (const d of sortedDates) {
          daily.push(finalizeBucket(dailyMap.get(d)));
        }
      }
    }
  }

  const periodFinal = finalizeBucket(periodAcc);
  const activeDays = dailyMap.size;

  const totalAllAgentCost = Array.from(agentMap.values()).reduce((sum, a) => sum + a.costUsd, 0);
  const totalAllAgentTokens = Array.from(agentMap.values()).reduce((sum, a) => sum + a.total, 0);
  const agentsSummary = Array.from(agentMap.values()).map((a) => {
    const { sessionIds, ...rest } = a;
    const fin = finalizeBucket(rest);
    return {
      ...fin,
      sessions: sessionIds.size,
      costSharePct: totalAllAgentCost > 0 ? (fin.costUsd / totalAllAgentCost) * 100 : 0,
      tokenSharePct: totalAllAgentTokens > 0 ? (fin.total / totalAllAgentTokens) * 100 : 0,
    };
  });

  const models = Array.from(modelMap.values())
    .map((m) => {
      const { agents: agentSet, ...rest } = m;
      const tierExtras = [];
      if (m.fastSteps > 0) tierExtras.push(`${m.fastSteps} fast 2x`);
      if (m.flexSteps > 0) tierExtras.push(`${m.flexSteps} flex 0.5x`);
      const tierNote = tierExtras.length ? `${rest.tierNote} (${tierExtras.join(', ')})` : rest.tierNote;
      return {
        ...finalizeBucket(rest),
        tierNote,
        agents: Array.from(agentSet).sort(),
        sharePct: periodFinal.costUsd > 0 ? (m.costUsd / periodFinal.costUsd) * 100 : 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.total - a.total);

  let activeSession = null;
  if (activeSessionId) {
    const canIncludeSession = (s) =>
      Boolean(s) && allowedSet.has(s.agent) && (agentFilter === 'all' || s.agent === agentFilter);
    let targetAgent = '';
    if (agentFilter !== 'all') {
      if (allowedSet.has(agentFilter)) targetAgent = agentFilter;
    } else if (activeAccByAgent.size > 0) {
      if (activeAccByAgent.has('antigravity')) {
        targetAgent = 'antigravity';
      } else {
        targetAgent = allowedList.find((id) => activeAccByAgent.has(id)) || activeAccByAgent.keys().next().value || '';
      }
    } else {
      const agMeta = sessions[sessionKey('antigravity', activeSessionId)];
      if (canIncludeSession(agMeta)) {
        targetAgent = 'antigravity';
      } else {
        const matchedMeta = Object.values(sessions).find(
          (s) => s.sessionId === activeSessionId && canIncludeSession(s),
        );
        if (matchedMeta) targetAgent = matchedMeta.agent;
      }
    }

    if (targetAgent) {
      const acc = activeAccByAgent.get(targetAgent) || null;
      const metaCandidate = sessions[sessionKey(targetAgent, activeSessionId)] || null;
      const meta = canIncludeSession(metaCandidate) ? metaCandidate : null;
      if (meta || (acc && acc.steps > 0)) {
        activeSession = {
          sessionId: activeSessionId,
          convId: activeSessionId,
          agent: targetAgent,
          title: meta?.title || '',
          ...finalizeBucket(acc || emptyBucket()),
        };
      }
    }
  }

  const sessionList = Array.from(sessionMap.values())
    .map((s) => {
      let primaryModel = 'unknown';
      let maxCnt = -1;
      for (const [m, cnt] of Object.entries(s.modelCounts)) {
        if (cnt > maxCnt) {
          maxCnt = cnt;
          primaryModel = m;
        }
      }
      const { modelCounts: _mc, ...rest } = s;
      return {
        ...finalizeBucket(rest),
        primaryModel,
        primaryModelLabel: formatModelLabel(primaryModel),
        isCurrent: Boolean(
          activeSession && s.sessionId === activeSession.sessionId && s.agent === activeSession.agent,
        ),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.lastTs - a.lastTs);

  const availableAgents = AGENT_IDS.filter((id) => availableAgentSet.has(id));
  for (const id of availableAgentSet) {
    if (!availableAgents.includes(id)) availableAgents.push(id);
  }

  const utcDay = new Date(now).toISOString().slice(0, 10);

  return {
    generatedAt: now,
    etag: `${fingerprint}|today=${todayStr}|ud=${utcDay}|d=${days}|tz=${resolvedTz}|al=${allowedList.join(',')}|a=${agentFilter}|c=${activeSessionId}`,
    todayDate: todayStr,
    rangeDays: days,
    timeZone: resolvedTz,
    agentFilter,
    availableAgents,
    today: finalizeBucket(todayAcc),
    period: {
      ...periodFinal,
      activeDays,
      avgDailyCostUsd: activeDays > 0 ? periodFinal.costUsd / activeDays : 0,
    },
    allTime: {
      ...finalizeBucket(allTimeAcc),
      totalSessions: allTimeFilteredSessions.size,
      totalEvents: allTimeFilteredEvents,
    },
    activeSession,
    agents: agentsSummary,
    daily,
    models,
    sessions: sessionList,
    officialRateCard: listOfficialRateCard(now),
    prefs,
  };
}

export function exportDailyCsv(report) {
  const rate = report.prefs.currency === 'CNY' ? report.prefs.cnyRate : 1;
  const cur = report.prefs.currency.toLowerCase();
  const header = [
    'date',
    'agent_filter',
    'steps',
    'input_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'output_tokens',
    'reasoning_tokens',
    'total_tokens',
    'cache_hit_pct',
    `est_cost_${cur}`,
    `cache_saved_${cur}`,
  ].join(',');

  const rows = [...report.daily]
    .reverse()
    .map((d) =>
      [
        d.date,
        report.agentFilter || 'all',
        d.steps,
        d.input,
        d.cacheRead,
        d.cacheWrite,
        d.output,
        d.reasoning,
        d.total,
        (d.cacheHitRate * 100).toFixed(2),
        (d.costUsd * rate).toFixed(4),
        (d.cacheSavedUsd * rate).toFixed(4),
      ].join(','),
    );
  return [header, ...rows].join('\n') + '\n';
}
