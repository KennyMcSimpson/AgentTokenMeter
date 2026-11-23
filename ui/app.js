(() => {
  const POLL_MS = 5000;
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const params = new URLSearchParams(location.search);

  const AGENT_COLORS = {
    antigravity: 'var(--tm-ag)',
    'claude-code': 'var(--tm-cc)',
    codex: 'var(--tm-codex)',
  };

  const AGENT_NAMES = {
    antigravity: 'Antigravity',
    'claude-code': 'Claude Code',
    codex: 'Codex',
  };

  const hostCfg = window.__ATM_CONFIG__ && typeof window.__ATM_CONFIG__ === 'object' ? window.__ATM_CONFIG__ : {};

  const PROVIDER_LABELS = {
    google: 'Google',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    custom: 'Custom',
    unknown: 'Unknown',
  };

  // ---------- HostBridge (decouples Antigravity Sidecar vs Standalone Browser) ----------
  const isSidecarHost = Boolean(window.sidecar);

  const HostBridge = {
    isSidecar: isSidecarHost,
    getActiveSessionId() {
      return window.sidecar?.conversationId || params.get('sessionId') || params.get('conversationId') || '';
    },
    async fetch(path, opts = {}) {
      const fn = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await fn(path, opts);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res;
    },
    canOpenSession(agent) {
      return agent === 'antigravity' && Boolean(window.sidecar?.ui?.toggleConversation);
    },
    openOrCopySession(agent, sessionId, notify) {
      if (agent === 'antigravity' && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(sessionId);
        return;
      }
      const copyText =
        agent === 'claude-code' && !sessionId.includes(':')
          ? `claude --resume ${sessionId}`
          : agent === 'codex'
            ? `codex resume ${sessionId}`
            : sessionId;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(copyText).then(
          () => notify(`Copied: ${copyText.slice(0, 44)}`),
          () => notify(`Session ID: ${sessionId.slice(0, 16)}`),
        );
      } else {
        notify(`Session ID: ${sessionId.slice(0, 16)}`);
      }
    },
    initTheme() {
      if (isSidecarHost) {
        const syncFromHostCss = () => {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f6f7f9)';
          document.documentElement.appendChild(probe);
          const c = getComputedStyle(probe).color;
          probe.remove();
          const nums = (c.match(/[\d.]+/g) || []).map(Number);
          if (nums.length < 3) return;
          const scale = c.startsWith('color(') ? 1 : 255;
          const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
        };
        syncFromHostCss();
        new MutationObserver(syncFromHostCss).observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['style'],
        });
        return;
      }

      const btn = $('btn-theme');
      btn.classList.remove('hidden');
      const saved = (() => {
        try {
          return localStorage.getItem('atm-theme');
        } catch {
          return null;
        }
      })();
      const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
      const applyTheme = (mode) => {
        document.documentElement.dataset.theme = mode === 'dark' ? 'dark' : 'light';
      };
      applyTheme(saved || (mq?.matches ? 'dark' : 'light'));
      mq?.addEventListener?.('change', (e) => {
        try {
          if (!localStorage.getItem('atm-theme')) applyTheme(e.matches ? 'dark' : 'light');
        } catch {
          applyTheme(e.matches ? 'dark' : 'light');
        }
      });
      btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        try {
          localStorage.setItem('atm-theme', next);
        } catch {
          // ignore storage quota errors
        }
      });
    },
  };

  HostBridge.initTheme();

  const state = {
    agent: hostCfg.lockedAgent || params.get('agent') || hostCfg.defaultAgent || 'all',
    days: 7,
    metric: 'cost',
    tab: 'overview',
    etag: '',
    reqSeq: 0,
    report: null,
    selectedDate: null,
    sessionSearch: '',
    sessionSort: 'cost',
    pollTimer: null,
    toastTimer: null,
  };

  const clientTimeZone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  };

  async function getJson(path) {
    const res = await HostBridge.fetch(path, { method: 'GET' });
    return res.json();
  }

  async function postJson(path, body) {
    const res = await HostBridge.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // ---------- Formatters ----------
  function fmtCompact(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function fmtInt(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  function fmtPct(ratio) {
    return `${((Number(ratio) || 0) * 100).toFixed(1)}%`;
  }

  function currencyMeta(prefs) {
    const isCny = prefs?.currency === 'CNY';
    return {
      code: isCny ? 'CNY' : 'USD',
      sym: isCny ? '¥' : '$',
      mult: isCny ? Number(prefs?.cnyRate) || 7.25 : 1,
    };
  }

  function fmtMoney(usd, prefs, compact = false) {
    const { sym, mult } = currencyMeta(prefs);
    const val = (Number(usd) || 0) * mult;
    const sign = val < 0 ? '-' : '';
    const abs = Math.abs(val);
    if (compact && abs >= 1000) return `${sign}${sym}${(abs / 1000).toFixed(1)}k`;
    if (abs >= 100) return `${sign}${sym}${abs.toFixed(1)}`;
    if (abs >= 1) return `${sign}${sym}${abs.toFixed(2)}`;
    if (abs >= 0.01) return `${sign}${sym}${abs.toFixed(3)}`;
    if (abs === 0) return `${sym}0.00`;
    return `${sign}${sym}${abs.toFixed(4)}`;
  }

  function fmtRelTime(ts) {
    if (!ts) return '';
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  // ---------- Rendering ----------
  function renderHeader(report) {
    const { code, sym } = currencyMeta(report.prefs);
    $('btn-currency').textContent = `${code} ${sym}`;
    const sessLbl = report.allTime.totalSessions === 1 ? 'session' : 'sessions';
    const dayLbl = report.period.activeDays === 1 ? 'active day' : 'active days';
    $('header-meta').textContent = `${report.allTime.totalSessions} ${sessLbl} · ${report.period.activeDays} ${dayLbl}`;
    $('tab-count-models').textContent = report.models.length ? String(report.models.length) : '';
    $('tab-count-sessions').textContent = report.sessions.length ? String(report.sessions.length) : '';

    const locked = report.lockedAgent || hostCfg.lockedAgent || '';
    const avail = Array.isArray(report.availableAgents) ? report.availableAgents : [];
    const visibleAgents = new Set(avail);
    if (report.agentFilter && report.agentFilter !== 'all') {
      visibleAgents.add(report.agentFilter);
    }

    const group = $('agent-group');
    const scopeBadge = $('scope-badge');

    if (locked || visibleAgents.size <= 1) {
      group.classList.add('hidden');
      const activeSingle = locked || (report.agentFilter !== 'all' ? report.agentFilter : avail[0] || '');
      if (activeSingle && Object.hasOwn(AGENT_NAMES, activeSingle)) {
        scopeBadge.textContent = AGENT_NAMES[activeSingle];
        scopeBadge.className = `badge badge-agent-${activeSingle}`;
      } else {
        scopeBadge.className = 'badge hidden';
      }
    } else {
      scopeBadge.className = 'badge hidden';
      group.classList.remove('hidden');
      group.querySelectorAll('.seg-btn').forEach((b) => {
        const id = b.dataset.agent;
        const show = id === 'all' || visibleAgents.has(id);
        b.classList.toggle('hidden', !show);
        b.classList.toggle('active', id === report.agentFilter);
      });
    }
  }

  function renderKpis(report) {
    const p = report.prefs;
    const periodLabel =
      report.rangeDays === 0 ? 'All-Time Eq. Cost' : report.rangeDays === 1 ? "Today's Eq. Cost" : `Last ${report.rangeDays}d Eq. Cost`;
    const todaySub = `Today ${fmtMoney(report.today.costUsd, p)} · Avg ${fmtMoney(report.period.avgDailyCostUsd, p)}/d`;

    const sess = report.activeSession;
    const card4 = sess
      ? {
          label: 'Active Session',
          value: fmtMoney(sess.costUsd, p),
          sub: `${fmtCompact(sess.total)} tok · ${sess.steps} steps`,
        }
      : {
          label: 'All-Time Eq. Cost',
          value: fmtMoney(report.allTime.costUsd, p),
          sub: `${fmtCompact(report.allTime.total)} tok · ${report.allTime.totalSessions} sessions`,
        };

    const tokSubParts = [
      `In ${fmtCompact(report.period.input)}`,
      `CR ${fmtCompact(report.period.cacheRead)}`,
    ];
    if (report.period.cacheWrite > 0) tokSubParts.push(`CW ${fmtCompact(report.period.cacheWrite)}`);
    tokSubParts.push(`Out ${fmtCompact(report.period.output)}`);

    const savedNote =
      report.period.cacheSavedUsd >= 0
        ? `Net cache saved ~${fmtMoney(report.period.cacheSavedUsd, p)}`
        : `Cache write overhead ${fmtMoney(Math.abs(report.period.cacheSavedUsd), p)}`;

    const cards = [
      { label: periodLabel, value: fmtMoney(report.period.costUsd, p), sub: todaySub },
      { label: 'Period Tokens', value: fmtCompact(report.period.total), sub: tokSubParts.join(' · ') },
      { label: 'Cache Hit Rate', value: fmtPct(report.period.cacheHitRate), sub: savedNote },
      card4,
    ];

    $('kpi-grid').innerHTML = cards
      .map(
        (c) => `
      <div class="kpi-card">
        <div class="kpi-label"><span>${esc(c.label)}</span></div>
        <div class="kpi-value">${esc(c.value)}</div>
        <div class="kpi-sub" title="${esc(c.sub)}">${esc(c.sub)}</div>
      </div>`,
      )
      .join('');
  }

  function renderAgentBreakdown(report) {
    const card = $('agent-breakdown-card');
    const active = (report.agents || []).filter((a) => a.steps > 0);
    if (report.agentFilter !== 'all' || active.length < 2) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const p = report.prefs;
    const useCost = active.some((a) => a.costUsd > 0);
    $('agent-breakdown-sub').textContent = `${active.length} active agents`;

    $('agent-breakdown-bar').innerHTML = active
      .map((a) => {
        const pct = useCost ? a.costSharePct : a.tokenSharePct;
        const color = AGENT_COLORS[a.agent] || 'var(--tm-primary)';
        return `<div class="agent-split-seg" style="width:${Math.max(2, pct).toFixed(1)}%;background:${color}" title="${esc(a.label)}: ${pct.toFixed(1)}%"></div>`;
      })
      .join('');

    $('agent-breakdown-list').innerHTML = active
      .map((a) => {
        const pct = useCost ? a.costSharePct : a.tokenSharePct;
        const color = AGENT_COLORS[a.agent] || 'var(--tm-primary)';
        return `
        <span class="agent-split-item">
          <span class="legend-swatch" style="background:${color}"></span>
          <span>${esc(a.label)}</span>
          <strong>${esc(fmtMoney(a.costUsd, p))}</strong>
          <span>(${pct.toFixed(1)}% · ${fmtCompact(a.total)} tok)</span>
        </span>`;
      })
      .join('');
  }

  function renderChart(report) {
    const daily = report.daily || [];
    const wrap = $('chart-wrap');
    const legend = $('chart-legend');
    const detail = $('chart-detail');

    if (daily.length === 0) {
      legend.innerHTML = '';
      wrap.innerHTML = '<div class="empty-state">No token usage recorded in this period</div>';
      detail.innerHTML = '';
      return;
    }

    if (!state.selectedDate || !daily.some((d) => d.date === state.selectedDate)) {
      const lastActive = [...daily].reverse().find((d) => d.steps > 0);
      state.selectedDate = (lastActive || daily[daily.length - 1]).date;
    }

    const p = report.prefs;
    const isCost = state.metric === 'cost';
    const hasCw = report.period.cacheWrite > 0;

    if (isCost) {
      legend.innerHTML =
        '<span class="legend-item"><span class="legend-swatch" style="background:var(--tm-cost)"></span>Daily Equivalent API Cost (Google / Anthropic / OpenAI)</span>';
    } else {
      legend.innerHTML = `
        <span class="legend-item"><span class="legend-swatch" style="background:var(--tm-cache)"></span>Cache Read</span>
        ${hasCw ? '<span class="legend-item"><span class="legend-swatch" style="background:var(--tm-cw)"></span>Cache Write</span>' : ''}
        <span class="legend-item"><span class="legend-swatch" style="background:var(--tm-input)"></span>Uncached Input</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--tm-output)"></span>Output</span>
      `;
    }

    const W = 640;
    const H = 196;
    const padL = 54;
    const padR = 12;
    const padT = 14;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxVal = Math.max(
      ...daily.map((d) => (isCost ? d.costUsd : d.total)),
      isCost ? 0.01 : 1000,
    );

    const yTicks = [0, 0.25, 0.5, 0.75, 1];
    const gridSvg = yTicks
      .map((t) => {
        const y = padT + plotH * (1 - t);
        const val = maxVal * t;
        const lbl = isCost ? fmtMoney(val, p, true) : fmtCompact(val);
        return `
          <line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" />
          <text class="chart-axis-text" x="${padL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(lbl)}</text>
        `;
      })
      .join('');

    const n = daily.length;
    const stepW = plotW / n;
    const barW = Math.max(3, Math.min(34, stepW * 0.66));
    const maxLabels = Math.min(n, 7);
    const labelEvery = Math.max(1, Math.ceil(n / maxLabels));

    const barsSvg = daily
      .map((d, idx) => {
        const cx = padL + idx * stepW + stepW / 2;
        const bx = cx - barW / 2;
        const selected = d.date === state.selectedDate;
        let shapes = '';

        if (isCost) {
          const h = Math.max(d.costUsd > 0 ? 2 : 0, (d.costUsd / maxVal) * plotH);
          const y = padT + plotH - h;
          shapes = `<rect x="${bx.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" fill="var(--tm-cost)" opacity="${selected ? '1' : '0.84'}" />`;
        } else {
          const hCache = (d.cacheRead / maxVal) * plotH;
          const hCw = (d.cacheWrite / maxVal) * plotH;
          const hIn = (d.input / maxVal) * plotH;
          const hOut = (d.output / maxVal) * plotH;
          const yCache = padT + plotH - hCache;
          const yCw = yCache - hCw;
          const yIn = yCw - hIn;
          const yOut = yIn - hOut;
          const op = selected ? '1' : '0.86';
          shapes = `
            ${hCache > 0 ? `<rect x="${bx.toFixed(1)}" y="${yCache.toFixed(1)}" width="${barW.toFixed(1)}" height="${hCache.toFixed(1)}" fill="var(--tm-cache)" opacity="${op}" />` : ''}
            ${hCw > 0 ? `<rect x="${bx.toFixed(1)}" y="${yCw.toFixed(1)}" width="${barW.toFixed(1)}" height="${hCw.toFixed(1)}" fill="var(--tm-cw)" opacity="${op}" />` : ''}
            ${hIn > 0 ? `<rect x="${bx.toFixed(1)}" y="${yIn.toFixed(1)}" width="${barW.toFixed(1)}" height="${hIn.toFixed(1)}" fill="var(--tm-input)" opacity="${op}" />` : ''}
            ${hOut > 0 ? `<rect x="${bx.toFixed(1)}" y="${yOut.toFixed(1)}" width="${barW.toFixed(1)}" height="${hOut.toFixed(1)}" rx="1.5" fill="var(--tm-output)" opacity="${op}" />` : ''}
          `;
        }

        const showTick = idx === 0 || idx === n - 1 || idx % labelEvery === 0;
        const shortDate = d.date.slice(5);
        const tick = showTick
          ? `<text class="chart-axis-text" x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(shortDate)}</text>`
          : '';

        return `
          <g class="bar-group${selected ? ' selected' : ''}" data-date="${esc(d.date)}">
            <rect class="bar-hit" x="${(padL + idx * stepW).toFixed(1)}" y="${padT}" width="${stepW.toFixed(1)}" height="${plotH}" />
            ${shapes}
            ${tick}
          </g>
        `;
      })
      .join('');

    wrap.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily trend chart">${gridSvg}${barsSvg}</svg>`;

    const selectDay = (dateStr) => {
      state.selectedDate = dateStr;
      wrap.querySelectorAll('.bar-group').forEach((g) => {
        g.classList.toggle('selected', g.dataset.date === dateStr);
      });
      $('daily-tbody')
        .querySelectorAll('tr')
        .forEach((tr) => tr.classList.toggle('selected-row', tr.dataset.date === dateStr));
      renderSelectedDetail(report);
    };

    wrap.querySelectorAll('.bar-group').forEach((g) => {
      g.addEventListener('mouseenter', () => selectDay(g.dataset.date));
      g.addEventListener('click', () => selectDay(g.dataset.date));
    });

    renderSelectedDetail(report);
  }

  function renderSelectedDetail(report) {
    const d = (report.daily || []).find((x) => x.date === state.selectedDate);
    if (!d) {
      $('chart-detail').innerHTML = '';
      return;
    }
    const p = report.prefs;
    $('chart-detail').innerHTML = `
      <span class="detail-date">${esc(d.date)}${d.date === report.todayDate ? ' (Today)' : ''}</span>
      <div class="detail-metrics">
        <span>Cost <strong>${esc(fmtMoney(d.costUsd, p))}</strong></span>
        <span>Steps <strong>${fmtInt(d.steps)}</strong></span>
        <span>In <strong>${fmtCompact(d.input)}</strong></span>
        <span>CacheR <strong>${fmtCompact(d.cacheRead)}</strong> (${fmtPct(d.cacheHitRate)})</span>
        ${d.cacheWrite > 0 ? `<span>CacheW <strong>${fmtCompact(d.cacheWrite)}</strong></span>` : ''}
        <span>Out <strong>${fmtCompact(d.output)}</strong></span>
      </div>
    `;
  }

  function renderDailyTable(report) {
    const p = report.prefs;
    const rows = [...(report.daily || [])].reverse();
    const showCw = report.period.cacheWrite > 0;
    $('th-cw').classList.toggle('hidden', !showCw);

    const tbody = $('daily-tbody');
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${showCw ? 8 : 7}" class="empty-state">No data</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (d) => `
      <tr data-date="${esc(d.date)}" class="${d.date === state.selectedDate ? 'selected-row' : ''}">
        <td><code>${esc(d.date)}</code>${d.date === report.todayDate ? ' <span class="badge badge-current">Today</span>' : ''}</td>
        <td class="num">${fmtInt(d.steps)}</td>
        <td class="num">${fmtCompact(d.input)}</td>
        <td class="num">${fmtCompact(d.cacheRead)}</td>
        ${showCw ? `<td class="num">${fmtCompact(d.cacheWrite)}</td>` : ''}
        <td class="num">${fmtCompact(d.output)}</td>
        <td class="num">${d.steps > 0 ? fmtPct(d.cacheHitRate) : '—'}</td>
        <td class="num cost-cell">${fmtMoney(d.costUsd, p)}</td>
      </tr>`,
      )
      .join('');

    tbody.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        state.selectedDate = tr.dataset.date;
        renderChart(report);
        tbody.querySelectorAll('tr').forEach((r) => r.classList.toggle('selected-row', r === tr));
      });
    });
  }

  function renderModels(report) {
    const p = report.prefs;
    const models = report.models || [];
    const unpricedNote = report.period.unpricedSteps > 0 ? ` · ${report.period.unpricedSteps} unpriced` : '';
    const modelLbl = models.length === 1 ? 'model' : 'models';
    $('models-subtitle').textContent = `${models.length} ${modelLbl} · Period total ${fmtMoney(report.period.costUsd, p)}${unpricedNote}`;
    const box = $('models-list');

    if (models.length === 0) {
      box.innerHTML = '<div class="empty-state">No model usage recorded in this period</div>';
      return;
    }

    const maxCost = Math.max(...models.map((m) => m.costUsd), 0.0001);
    box.innerHTML = models
      .map((m) => {
        const w = m.matchType === 'unpriced' ? 2 : Math.max(2, Math.round((m.costUsd / maxCost) * 100));
        const providerLbl = PROVIDER_LABELS[m.provider] || m.provider;
        let statusBadge = `<span class="badge badge-official" title="${esc(m.tierNote)}">${esc(providerLbl)} Official</span>`;
        if (m.matchType === 'custom') {
          statusBadge = `<span class="badge badge-custom" title="${esc(m.tierNote)}">Custom Rate</span>`;
        } else if (m.matchType === 'unpriced') {
          statusBadge = `<span class="badge badge-unpriced" title="${esc(m.tierNote)}">Unpriced</span>`;
        } else if (m.matchType === 'legacy_estimate') {
          statusBadge = `<span class="badge badge-fallback" title="${esc(m.tierNote)}">Legacy Estimate</span>`;
        }

        const rateText =
          m.matchType === 'unpriced'
            ? 'Unlisted model (add rate in pricing.override.json)'
            : m.cacheWrite > 0 || m.provider === 'anthropic'
              ? `$${m.rate.input} / $${m.rate.cacheRead}r / $${m.rate.cacheWrite5m}(5m) / $${m.rate.cacheWrite1h}(1h) / $${m.rate.output} per 1M`
              : `$${m.rate.input} / $${m.rate.cacheRead} / $${m.rate.output} per 1M`;

        return `
        <div class="model-row">
          <div class="model-top">
            <div class="model-ident">
              <span class="model-name">${esc(m.label)}</span>
              ${m.model !== 'unknown' ? `<span class="model-slug">${esc(m.model)}</span>` : ''}
              ${statusBadge}
            </div>
            <div class="model-cost-wrap">
              <span class="model-cost">${m.matchType === 'unpriced' ? '—' : esc(fmtMoney(m.costUsd, p))}</span>
              <span class="model-share">${m.matchType === 'unpriced' ? '' : `${m.sharePct.toFixed(1)}%`}</span>
            </div>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
          <div class="model-meta">
            <span>${fmtInt(m.steps)} steps · In ${fmtCompact(m.input)} · CR ${fmtCompact(m.cacheRead)} (${fmtPct(m.cacheHitRate)})${m.cacheWrite > 0 ? ` · CW ${fmtCompact(m.cacheWrite)}` : ''} · Out ${fmtCompact(m.output)}</span>
            <span title="${esc(m.tierNote || '')}">${esc(rateText)}</span>
          </div>
        </div>`;
      })
      .join('');
  }

  function renderSessions(report) {
    const p = report.prefs;
    const q = state.sessionSearch.trim().toLowerCase();
    let list = [...(report.sessions || [])];
    if (q) {
      list = list.filter(
        (s) =>
          (s.title || '').toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q) ||
          s.primaryModel.toLowerCase().includes(q) ||
          (s.agentLabel || '').toLowerCase().includes(q),
      );
    }
    if (state.sessionSort === 'tokens') {
      list.sort((a, b) => b.total - a.total);
    } else if (state.sessionSort === 'recent') {
      list.sort((a, b) => b.lastTs - a.lastTs);
    } else {
      list.sort((a, b) => b.costUsd - a.costUsd || b.lastTs - a.lastTs);
    }

    const box = $('sessions-list');
    if (list.length === 0) {
      box.innerHTML = '<div class="empty-state">No matching sessions</div>';
      return;
    }

    const totalMatched = list.length;
    const visible = list.slice(0, 100);
    const overflowNote =
      totalMatched > visible.length
        ? `<div class="card-sub" style="text-align:center;padding:6px 0;">Showing top ${visible.length} of ${totalMatched} sessions. Use search to narrow down.</div>`
        : '';

    box.innerHTML =
      visible
        .map((s) => {
          const canOpen = HostBridge.canOpenSession(s.agent);
          const hint = canOpen ? 'Click to jump to this conversation' : `Click to copy resume command / ID (${s.sessionId})`;
          return `
        <button type="button" class="session-row clickable${s.isCurrent ? ' is-current' : ''}" data-agent="${esc(s.agent)}" data-sid="${esc(s.sessionId)}" title="${esc(hint)}">
          <div class="session-head">
            <div class="session-title">${esc(s.title || `Session ${s.sessionId.slice(0, 10)}`)}</div>
            <div class="session-cost">${esc(fmtMoney(s.costUsd, p))}</div>
          </div>
          <div class="session-foot">
            <span class="badge badge-agent-${esc(s.agent)}">${esc(s.agentLabel)}</span>
            ${s.isCurrent ? '<span class="badge badge-current">Active</span>' : ''}
            <span>${esc(s.primaryModelLabel)}</span>
            <span>${fmtInt(s.steps)} steps</span>
            <span>${fmtCompact(s.total)} tok (hit ${fmtPct(s.cacheHitRate)})</span>
            <span class="spacer"></span>
            <span>${esc(fmtRelTime(s.lastTs))}</span>
          </div>
        </button>`;
        })
        .join('') + overflowNote;

    box.querySelectorAll('.session-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        HostBridge.openOrCopySession(btn.dataset.agent, btn.dataset.sid, showToast);
      });
    });
  }

  function renderAll(report) {
    state.report = report;
    $('loading').classList.add('hidden');
    $('app').classList.remove('hidden');

    renderHeader(report);
    renderKpis(report);
    renderAgentBreakdown(report);
    renderChart(report);
    renderDailyTable(report);
    renderModels(report);
    renderSessions(report);
  }

  // ---------- Polling & Actions ----------
  async function loadReport({ force = false } = {}) {
    const seq = ++state.reqSeq;
    const qs = new URLSearchParams({
      days: String(state.days),
      agent: state.agent,
    });
    const tz = clientTimeZone();
    if (tz) qs.set('tz', tz);
    const sid = HostBridge.getActiveSessionId();
    if (sid) qs.set('sessionId', sid);
    if (!force && state.etag) qs.set('etag', state.etag);
    if (force) qs.set('force', '1');

    try {
      const data = await getJson(`/api/report?${qs.toString()}`);
      if (seq !== state.reqSeq) return;
      const pill = $('live-pill');
      pill.classList.remove('syncing');
      if (data.syncError) {
        pill.classList.add('syncing');
        pill.title = `Sync error: ${data.syncError}`;
        $('live-text').textContent = 'Sync Error';
      } else {
        pill.title = data.syncedAt ? `Auto-syncs every 5s · Last synced: ${fmtRelTime(data.syncedAt)}` : 'Auto-syncs every 5s';
        $('live-text').textContent = 'Live';
      }
      if (data.unchanged) return;
      if (data.agentFilter) state.agent = data.agentFilter;
      state.etag = data.etag || '';
      renderAll(data);
    } catch (err) {
      if (seq !== state.reqSeq) return;
      $('live-text').textContent = 'Offline';
      console.error('[agent-token-meter] poll failed:', err);
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(async () => {
      await loadReport({ force: false });
      schedulePoll();
    }, POLL_MS);
  }

  function switchTab(tabName) {
    state.tab = tabName;
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t.dataset.tab === tabName;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `panel-${tabName}`);
    });
  }

  // ---------- Event Wiring ----------
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('agent-group').querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.agent = btn.dataset.agent;
      state.etag = '';
      state.selectedDate = null;
      $('agent-group')
        .querySelectorAll('.seg-btn')
        .forEach((b) => b.classList.toggle('active', b === btn));
      loadReport({ force: false });
    });
  });

  $('range-group').querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.days = Number(btn.dataset.days);
      state.etag = '';
      state.selectedDate = null;
      $('range-group')
        .querySelectorAll('.seg-btn')
        .forEach((b) => b.classList.toggle('active', b === btn));
      loadReport({ force: false });
    });
  });

  document.querySelectorAll('[data-metric]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.metric = btn.dataset.metric;
      document
        .querySelectorAll('[data-metric]')
        .forEach((b) => b.classList.toggle('active', b === btn));
      if (state.report) renderChart(state.report);
    });
  });

  $('btn-currency').addEventListener('click', async () => {
    if (!state.report) return;
    const next = state.report.prefs.currency === 'CNY' ? 'USD' : 'CNY';
    try {
      await postJson('/api/prefs', { currency: next });
      state.etag = '';
      await loadReport({ force: false });
      showToast(`Currency switched to ${next}`);
    } catch (err) {
      showToast(`Switch failed: ${err.message}`);
    }
  });

  $('btn-sync').addEventListener('click', async () => {
    const btn = $('btn-sync');
    btn.classList.add('spinning');
    $('live-pill').classList.add('syncing');
    try {
      const res = await postJson('/api/sync', { full: false });
      state.etag = '';
      await loadReport({ force: false });
      schedulePoll();
      showToast(res.added > 0 ? `Synced ${res.added} new record(s)` : 'Up to date');
    } catch (err) {
      showToast(`Sync failed: ${err.message}`);
    } finally {
      btn.classList.remove('spinning');
      $('live-pill').classList.remove('syncing');
    }
  });

  $('btn-export').addEventListener('click', async () => {
    try {
      const qs = new URLSearchParams({
        days: String(state.days),
        agent: state.agent,
      });
      const tz = clientTimeZone();
      if (tz) qs.set('tz', tz);
      const res = await HostBridge.fetch(`/api/export.csv?${qs.toString()}`, { method: 'GET' });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = state.agent === 'all' ? '' : `-${state.agent}`;
      a.download = `agent-token-meter-${state.report?.todayDate || 'export'}${suffix}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('CSV exported');
    } catch (err) {
      showToast(`Export failed: ${err.message}`);
    }
  });

  $('session-search').addEventListener('input', (e) => {
    state.sessionSearch = e.target.value;
    if (state.report) renderSessions(state.report);
  });

  $('session-sort').addEventListener('change', (e) => {
    state.sessionSort = e.target.value;
    if (state.report) renderSessions(state.report);
  });

  // Boot
  loadReport({ force: true }).then(schedulePoll);
})();
