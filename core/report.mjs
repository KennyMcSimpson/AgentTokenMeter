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
const tzFormatterCache = new Map();

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
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    tzFormatterCache.set(timeZone, fmt);
  }
  return fmt.format(tsMs);
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
  const activeSessionAcc = emptyBucket();

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

  // Inherit parent model for legacy pre-Nov-19 Antigravity subagents via parentSessionId chain
  const inheritedModelCache = new Map();
  const resolveEventModel = (evAgent, sid, rawModel) => {
    const norm = normalizeModel(rawModel);
    if (norm !== 'unknown' || evAgent !== 'antigravity') return norm;
    const cacheKey = sessionKey(evAgent, sid);
    if (inheritedModelCache.has(cacheKey)) return inheritedModelCache.get(cacheKey);
    let cur = sid;
    const visited = new Set([sid]);
    let found = 'unknown';
    while (cur) {
      const meta = sessions[sessionKey(evAgent, cur)];
      const parent = meta?.parentSessionId;
      if (!parent || visited.has(parent)) break;
      visited.add(parent);
      const pm = normalizeModel(sessions[sessionKey(evAgent, parent)]?.lastModel);
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
    const model = resolveEventModel(e.a, e.c, e.m);
    const promptTotal = e.in + e.cr + e.cw5 + e.cw1h;
    const rate = resolveModelRate(model, { ts: e.ts, promptTotal, agent: e.a, overrides });
    const cost = calcCostUsd(
      { input: e.in, cacheRead: e.cr, cacheWrite5m: e.cw5, cacheWrite1h: e.cw1h, output: e.out },
      rate,
    );
    const dateStr = localDateKey(e.ts, resolvedTz);
    // For bounded windows (`days > 0`), exclude future-dated events so `period` and `daily` always reconcile
    const inPeriod = days === 0 || (dateStr >= startDateStr && dateStr <= todayStr);

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

    if (agentFilter !== 'all' && e.a !== agentFilter) continue;

    allTimeFilteredEvents += 1;
    allTimeFilteredSessions.add(sessionKey(e.a, e.c));
    accumulate(allTimeAcc, e, cost);

    if (dateStr === todayStr) {
      accumulate(todayAcc, e, cost);
    }
    if (activeSessionId && e.c === activeSessionId) {
      accumulate(activeSessionAcc, e, cost);
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
      };
      modelMap.set(modelBucketKey, mEntry);
    }
    mEntry.agents.add(e.a);
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
      return {
        ...finalizeBucket(rest),
        agents: Array.from(agentSet).sort(),
        sharePct: periodFinal.costUsd > 0 ? (m.costUsd / periodFinal.costUsd) * 100 : 0,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.total - a.total);

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
        isCurrent: Boolean(activeSessionId && s.sessionId === activeSessionId),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.lastTs - a.lastTs);

  let activeSession = null;
  if (activeSessionId) {
    const meta =
      sessions[sessionKey(agentFilter === 'all' ? 'antigravity' : agentFilter, activeSessionId)] ||
      Object.values(sessions).find((s) => s.sessionId === activeSessionId) ||
      null;
    activeSession = {
      sessionId: activeSessionId,
      convId: activeSessionId,
      agent: meta?.agent || (agentFilter === 'all' ? 'antigravity' : agentFilter),
      title: meta?.title || '',
      ...finalizeBucket(activeSessionAcc),
    };
  }

  const availableAgents = AGENT_IDS.filter((id) => availableAgentSet.has(id));
  for (const id of availableAgentSet) {
    if (!availableAgents.includes(id)) availableAgents.push(id);
  }

  return {
    generatedAt: now,
    etag: `${fingerprint}|today=${todayStr}|d=${days}|tz=${resolvedTz}|al=${allowedList.join(',')}|a=${agentFilter}|c=${activeSessionId}`,
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
