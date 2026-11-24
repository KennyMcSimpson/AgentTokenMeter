import { existsSync } from 'node:fs';
import { detectAdapterForPath, getAdapter, getAdapters, getEnabledAgentIds } from '../adapters/index.mjs';
import { canonicalFileKey, withLock } from './fs-utils.mjs';
import { getDataDir } from './pricing.mjs';
import {
  appendEventsByMonth,
  compactEventsPreservingArchived,
  mergeSessionMeta,
  readCursorsState,
  sessionKey,
  writeCursorsState,
} from './store.mjs';

function needsParserUpgrade(adapter, prevCursor) {
  if (!prevCursor || typeof prevCursor !== 'object') return false;
  if (prevCursor.agent && prevCursor.agent !== adapter.id) return true;
  const targetVer = Number(adapter.parserVersion) || 0;
  if (targetVer > 0 && (Number(prevCursor.parserVersion) || 0) < targetVer) {
    return true;
  }
  return false;
}

function makeScope(agent, sessionId, rolloutId = '') {
  if (!agent || !sessionId) return null;
  return {
    agent,
    sessionId,
    rolloutId: agent === 'codex' ? String(rolloutId || '').toLowerCase() : '',
  };
}

function scopeKey(s) {
  return `${s.agent}|${s.sessionId}|${s.rolloutId || ''}`;
}

function addScope(map, scope) {
  if (!scope) return;
  map.set(scopeKey(scope), scope);
}

function cursorScope(agent, cursor) {
  if (!cursor || typeof cursor !== 'object') return null;
  if (cursor.agent && cursor.agent !== agent) return null;
  if (typeof cursor.sessionId !== 'string' || !cursor.sessionId) return null;
  return makeScope(agent, cursor.sessionId, cursor.rolloutId || '');
}

function collectLegacyScopes(agent, cursor) {
  const out = [];
  if (!cursor || typeof cursor !== 'object') return out;
  if (Array.isArray(cursor.legacyScopes)) {
    for (const s of cursor.legacyScopes) {
      const norm = makeScope(agent, s?.sessionId, s?.rolloutId || '');
      if (norm) out.push(norm);
    }
  }
  if (Array.isArray(cursor.legacySessionIds)) {
    for (const id of cursor.legacySessionIds) {
      const norm = makeScope(agent, id, '');
      if (norm) out.push(norm);
    }
  }
  return out;
}

/**
 * Incrementally sync a single transcript/session file (used by Stop/SubagentStop hooks and statusLine).
 */
export function syncSingleSource(
  filePath,
  { agent = '', sessionId = '', dataDir = getDataDir(), lockWaitMs } = {},
) {
  if (!filePath || !existsSync(filePath)) {
    return { agent: agent || 'unknown', added: 0, scanned: 0 };
  }
  const adapter = agent ? getAdapter(agent) : detectAdapterForPath(filePath);
  if (!adapter) {
    return { agent: agent || 'unknown', added: 0, scanned: 0 };
  }
  if (!getEnabledAgentIds().includes(adapter.id)) {
    return { agent: adapter.id, added: 0, scanned: 0 };
  }

  const inferred = adapter.inferMeta(filePath);
  // Never overwrite a subagent's scoped sessionId with a parent session_id from hook payloads
  const resolvedSessionId = inferred.isSubagent
    ? inferred.sessionId
    : sessionId || inferred.sessionId;
  const resolvedParentId = inferred.isSubagent
    ? inferred.parentSessionId || sessionId || ''
    : inferred.parentSessionId || '';

  const meta = {
    ...inferred,
    agent: adapter.id,
    sessionId: resolvedSessionId,
    parentSessionId: resolvedParentId,
  };

  const fileKey = canonicalFileKey(filePath);
  const lockOpts = lockWaitMs !== undefined ? { waitMs: lockWaitMs } : undefined;
  const fastStatuslineMode = lockWaitMs !== undefined && lockWaitMs < 1000;

  return withLock(
    dataDir,
    () => {
      const state = readCursorsState(dataDir);
      const prevCursor = state.files[fileKey];
      const agentMismatch = Boolean(prevCursor && prevCursor.agent && prevCursor.agent !== adapter.id);
      const targetVer = Number(adapter.parserVersion) || 0;
      const sameAgentVersionUpgrade = Boolean(
        prevCursor &&
          !agentMismatch &&
          targetVer > 0 &&
          (Number(prevCursor.parserVersion) || 0) < targetVer,
      );
      const effectiveCursor = agentMismatch ? null : prevCursor;
      const res = adapter.scanDelta(filePath, effectiveCursor, meta, agentMismatch || sameAgentVersionUpgrade);
      if (!res) {
        return { agent: adapter.id, added: 0, scanned: 0, skipped: 1 };
      }
      if (res.unchanged) {
        return { agent: adapter.id, added: 0, scanned: 1 };
      }

      if (sameAgentVersionUpgrade) {
        const targetScopes = new Map();
        const prevSc = cursorScope(adapter.id, prevCursor);
        addScope(targetScopes, prevSc);
        for (const ls of collectLegacyScopes(adapter.id, prevCursor)) addScope(targetScopes, ls);
        const newSc = makeScope(
          adapter.id,
          res.cursor.sessionId || meta.sessionId,
          res.cursor.rolloutId || meta.rolloutId || '',
        );
        addScope(targetScopes, newSc);

        let hasSiblingInScope = false;
        for (const [fk, otherCursor] of Object.entries(state.files)) {
          if (fk === fileKey || !existsSync(fk)) continue;
          const os = cursorScope(adapter.id, otherCursor);
          if (os && targetScopes.has(scopeKey(os))) {
            hasSiblingInScope = true;
            break;
          }
          for (const ls of collectLegacyScopes(adapter.id, otherCursor)) {
            if (targetScopes.has(scopeKey(ls))) {
              hasSiblingInScope = true;
              break;
            }
          }
          if (hasSiblingInScope) break;
        }

        if (!hasSiblingInScope && !fastStatuslineMode) {
          // Safe to atomically replace this file's isolated legacy scope right now,
          // preventing any temporary double-counting in `summary --no-sync`.
          const { survivingSessionKeys } = compactEventsPreservingArchived(dataDir, res.events, {
            replaceScopes: targetScopes,
          });
          state.files[fileKey] = res.cursor;
          mergeSessionMeta(state, {
            agent: adapter.id,
            sessionId: res.cursor.sessionId || meta.sessionId,
            app: res.cursor.app || meta.app || adapter.id,
            title: res.cursor.title,
            parentSessionId: res.cursor.parentSessionId || meta.parentSessionId,
            firstModel: res.cursor.firstModel,
            lastModel: res.cursor.lastModel,
            firstTs: res.cursor.firstTs,
            lastTs: res.cursor.lastTs,
          });
          for (const s of targetScopes.values()) {
            const sk = sessionKey(s.agent, s.sessionId);
            if (!survivingSessionKeys.has(sk)) {
              delete state.sessions[sk];
            }
          }
          writeCursorsState(dataDir, state);
          return { agent: adapter.id, added: res.events.length, scanned: 1 };
        }

        // Another file shares the legacy scope (e.g., v2.0.0 fork collision) or fast statusline lock:
        // defer both ledger write and version bump to the next `syncAllSources()` so no duplicate
        // events temporarily appear in `summary --no-sync`.
        const legacyMap = new Map();
        for (const ls of collectLegacyScopes(adapter.id, prevCursor)) addScope(legacyMap, ls);
        addScope(legacyMap, prevSc);
        state.files[fileKey] = {
          ...prevCursor,
          parserVersion: Number(prevCursor.parserVersion) || 0,
          legacyScopes: Array.from(legacyMap.values()),
        };
        writeCursorsState(dataDir, state);
        return { agent: adapter.id, added: 0, scanned: 1, deferredUpgrade: true };
      }

      if (res.events.length) {
        appendEventsByMonth(dataDir, res.events);
      }
      state.files[fileKey] = res.cursor;
      mergeSessionMeta(state, {
        agent: adapter.id,
        sessionId: res.cursor.sessionId || meta.sessionId,
        app: res.cursor.app || meta.app || adapter.id,
        title: res.cursor.title,
        parentSessionId: res.cursor.parentSessionId || meta.parentSessionId,
        firstModel: res.cursor.firstModel,
        lastModel: res.cursor.lastModel,
        firstTs: res.cursor.firstTs,
        lastTs: res.cursor.lastTs,
      });
      writeCursorsState(dataDir, state);
      return { agent: adapter.id, added: res.events.length, scanned: 1 };
    },
    lockOpts,
  );
}

/**
 * Scan all configured agent adapters and persist new token events atomically.
 * - Replaces ledger entries strictly by file-level namespace `(agent, sessionId, rolloutId)`,
 *   preserving archived events from deleted transcripts — including deleted sibling rollouts
 *   sharing a Codex thread ID.
 * - Automatically detects legacy cursors needing a parser upgrade, convergently rescans all
 *   live files sharing affected namespaces, and removes vacated ghost sessions cleanly.
 * - Reports any unreadable/over-cap source files in `skipped` / `skippedFiles`.
 */
export function syncAllSources({ forceFullRescan = false, agents = null, dataDir = getDataDir(), lockWaitMs } = {}) {
  const selectedAdapters = getAdapters(agents);
  const discovered = [];
  const byAgentCount = {};

  for (const adapter of selectedAdapters) {
    const items = adapter.discoverSources();
    byAgentCount[adapter.id] = items.length;
    for (const item of items) {
      discovered.push({ adapter, item });
    }
  }

  const lockOpts = lockWaitMs !== undefined ? { waitMs: lockWaitMs } : undefined;

  return withLock(
    dataDir,
    () => {
      const state = readCursorsState(dataDir);
      const newEvents = [];
      const skippedFiles = [];
      const failedScopes = new Map();
      const replaceScopes = new Map();
      const rebuiltSessionMeta = new Map();
      const fullScannedFileKeys = new Set();
      const failedFileKeys = new Set();
      let changedFiles = 0;
      let upgradedAny = false;

      // Identify file namespaces impacted by parser upgrades so every live file sharing an
      // upgraded namespace is rescanned together and stale misattributed keys are replaced cleanly.
      const upgradeScopes = new Map();
      if (!forceFullRescan) {
        for (const { adapter, item } of discovered) {
          const prevCursor = state.files[canonicalFileKey(item.filePath)];
          if (needsParserUpgrade(adapter, prevCursor)) {
            upgradedAny = true;
            addScope(upgradeScopes, cursorScope(adapter.id, prevCursor));
            for (const ls of collectLegacyScopes(adapter.id, prevCursor)) {
              addScope(upgradeScopes, ls);
            }
            addScope(upgradeScopes, makeScope(adapter.id, item.sessionId, item.rolloutId || ''));
          }
        }
      }

      const scanDiscoveredItem = ({ adapter, item }, itemForceFull) => {
        const fileKey = canonicalFileKey(item.filePath);
        const prevCursor = state.files[fileKey];
        const prevSc = cursorScope(adapter.id, prevCursor);
        const legacySc = prevCursor?.agent === adapter.id ? collectLegacyScopes(adapter.id, prevCursor) : [];
        const itemSc = makeScope(adapter.id, item.sessionId, item.rolloutId || '');
        const effectiveCursor =
          prevCursor && prevCursor.agent && prevCursor.agent !== adapter.id ? null : prevCursor;

        const res = adapter.scanDelta(item.filePath, effectiveCursor, item, itemForceFull);
        if (!res) {
          failedFileKeys.add(fileKey);
          skippedFiles.push({ agent: adapter.id, filePath: item.filePath });
          addScope(failedScopes, prevSc);
          for (const ls of legacySc) addScope(failedScopes, ls);
          addScope(failedScopes, itemSc);
          return;
        }
        if (res.unchanged) return;

        changedFiles += 1;
        for (const e of res.events) newEvents.push(e);
        state.files[fileKey] = res.cursor;

        const newSid = res.cursor.sessionId || item.sessionId;
        const newRolloutId = res.cursor.rolloutId || item.rolloutId || '';
        const newSc = makeScope(adapter.id, newSid, newRolloutId);
        const newSk = sessionKey(adapter.id, newSid);

        const metaPatch = {
          agent: adapter.id,
          sessionId: newSid,
          app: res.cursor.app || item.app || adapter.id,
          title: res.cursor.title,
          parentSessionId: res.cursor.parentSessionId || item.parentSessionId,
          firstModel: res.cursor.firstModel,
          lastModel: res.cursor.lastModel,
          firstTs: res.cursor.firstTs,
          lastTs: res.cursor.lastTs,
        };

        if (itemForceFull) {
          fullScannedFileKeys.add(fileKey);
          addScope(replaceScopes, newSc);
          addScope(replaceScopes, prevSc);
          for (const ls of legacySc) addScope(replaceScopes, ls);
          const list = rebuiltSessionMeta.get(newSk) || [];
          list.push(metaPatch);
          rebuiltSessionMeta.set(newSk, list);
        } else {
          mergeSessionMeta(state, metaPatch);
        }
      };

      for (const entry of discovered) {
        const { adapter, item } = entry;
        const fileKey = canonicalFileKey(item.filePath);
        const prevCursor = state.files[fileKey];
        const prevSc = cursorScope(adapter.id, prevCursor);
        const itemSc = makeScope(adapter.id, item.sessionId, item.rolloutId || '');
        const itemInUpgrade =
          !forceFullRescan &&
          (needsParserUpgrade(adapter, prevCursor) ||
            (prevSc && upgradeScopes.has(scopeKey(prevSc))) ||
            (itemSc && upgradeScopes.has(scopeKey(itemSc))));
        scanDiscoveredItem(entry, Boolean(forceFullRescan || itemInUpgrade));
      }

      // Convergent closure: if an upgraded file resolved into a namespace already shared by
      // another live file that wasn't full-scanned yet, rescan that file too so `replaceScopes`
      // never drops a live sibling's events.
      if (!forceFullRescan && replaceScopes.size > 0) {
        let addedSibling = true;
        while (addedSibling) {
          addedSibling = false;
          for (const entry of discovered) {
            const fk = canonicalFileKey(entry.item.filePath);
            if (fullScannedFileKeys.has(fk) || failedFileKeys.has(fk)) continue;
            const curSc = cursorScope(entry.adapter.id, state.files[fk]);
            const itemSc = makeScope(entry.adapter.id, entry.item.sessionId, entry.item.rolloutId || '');
            const hitsReplaced =
              (curSc && replaceScopes.has(scopeKey(curSc))) ||
              (itemSc && replaceScopes.has(scopeKey(itemSc)));
            if (hitsReplaced) {
              addedSibling = true;
              scanDiscoveredItem(entry, true);
            }
          }
        }
      }

      // Never purge persisted events for any namespace whose live file failed to read in this run
      const failedSessionKeys = new Set();
      for (const [fKey, fScope] of failedScopes.entries()) {
        replaceScopes.delete(fKey);
        failedSessionKeys.add(sessionKey(fScope.agent, fScope.sessionId));
      }

      if (forceFullRescan || upgradedAny) {
        const { survivingSessionKeys } = compactEventsPreservingArchived(dataDir, newEvents, {
          replaceScopes,
        });

        // Track which sessions had their primary (non-revert) scope replaced so stale pre-upgrade
        // metadata on fully live sessions is refreshed, while sessions with deleted primary files
        // retain their archived title / firstTs / firstModel via non-destructive merge.
        const mainScopeReplaced = new Set();
        const touchedSessions = new Set();
        for (const s of replaceScopes.values()) {
          const sk = sessionKey(s.agent, s.sessionId);
          touchedSessions.add(sk);
          if (!s.rolloutId) mainScopeReplaced.add(sk);
        }

        for (const [sk, metas] of rebuiltSessionMeta.entries()) {
          if (mainScopeReplaced.has(sk) && !failedSessionKeys.has(sk)) {
            delete state.sessions[sk];
          }
          for (const m of metas) mergeSessionMeta(state, m);
        }

        for (const sk of touchedSessions) {
          if (!survivingSessionKeys.has(sk) && !rebuiltSessionMeta.has(sk)) {
            delete state.sessions[sk];
          }
        }

        writeCursorsState(dataDir, state);
      } else if (changedFiles > 0) {
        if (newEvents.length) {
          appendEventsByMonth(dataDir, newEvents);
        }
        writeCursorsState(dataDir, state);
      }

      return {
        totalSources: discovered.length,
        byAgent: byAgentCount,
        changedFiles,
        added: newEvents.length,
        skipped: skippedFiles.length,
        skippedFiles,
      };
    },
    lockOpts,
  );
}
