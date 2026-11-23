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

function collectLegacySessionIds(prevCursor) {
  const out = [];
  if (!prevCursor || typeof prevCursor !== 'object') return out;
  if (Array.isArray(prevCursor.legacySessionIds)) {
    for (const id of prevCursor.legacySessionIds) {
      if (typeof id === 'string' && id) out.push(id);
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
      if (res.events.length) {
        appendEventsByMonth(dataDir, res.events);
      }

      // Single-file hooks cannot safely purge sibling session keys in the ledger.
      // When upgrading a legacy cursor in-place, defer bumping `parserVersion` and record
      // prior session IDs so the next `syncAllSources()` performs atomic full-session cleanup.
      let cursorToSave = res.cursor;
      if (sameAgentVersionUpgrade) {
        const legacySet = new Set(collectLegacySessionIds(prevCursor));
        if (typeof prevCursor.sessionId === 'string' && prevCursor.sessionId) {
          legacySet.add(prevCursor.sessionId);
        }
        cursorToSave = {
          ...res.cursor,
          parserVersion: Number(prevCursor.parserVersion) || 0,
          legacySessionIds: Array.from(legacySet),
        };
      }

      state.files[fileKey] = cursorToSave;
      mergeSessionMeta(state, {
        agent: adapter.id,
        sessionId: res.cursor.sessionId || meta.sessionId,
        app: res.cursor.app || meta.app || adapter.id,
        title: res.cursor.title,
        parentSessionId: res.cursor.parentSessionId || meta.parentSessionId,
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
 * - Automatically detects legacy cursors needing a parser upgrade (including those touched first
 *   by `syncSingleSource`), convergently rescans all sibling files sharing affected sessions, and
 *   replaces stale misattributed events while preserving archived events from deleted transcripts.
 * - Reports any unreadable/over-cap source files in `skipped` / `skippedFiles` instead of dropping silently.
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
      const failedSessionKeys = new Set();
      const replaceSessionKeys = new Set();
      const rebuiltSessionMeta = new Map();
      const fullScannedFileKeys = new Set();
      const failedFileKeys = new Set();
      let changedFiles = 0;
      let upgradedAny = false;

      // Identify sessions impacted by parser upgrades so every live file sharing an upgraded
      // sessionId is rescanned together and stale misattributed ledger entries can be cleanly replaced.
      const upgradeSessionKeys = new Set();
      if (!forceFullRescan) {
        for (const { adapter, item } of discovered) {
          const prevCursor = state.files[canonicalFileKey(item.filePath)];
          if (needsParserUpgrade(adapter, prevCursor)) {
            upgradedAny = true;
            if (prevCursor?.sessionId) {
              upgradeSessionKeys.add(sessionKey(adapter.id, prevCursor.sessionId));
            }
            for (const lid of collectLegacySessionIds(prevCursor)) {
              upgradeSessionKeys.add(sessionKey(adapter.id, lid));
            }
            if (item.sessionId) {
              upgradeSessionKeys.add(sessionKey(adapter.id, item.sessionId));
            }
          }
        }
      }

      const scanDiscoveredItem = ({ adapter, item }, itemForceFull) => {
        const fileKey = canonicalFileKey(item.filePath);
        const prevCursor = state.files[fileKey];
        const prevSid = prevCursor?.agent === adapter.id ? prevCursor.sessionId || '' : '';
        const legacyIds = prevCursor?.agent === adapter.id ? collectLegacySessionIds(prevCursor) : [];
        const effectiveCursor =
          prevCursor && prevCursor.agent && prevCursor.agent !== adapter.id ? null : prevCursor;

        const res = adapter.scanDelta(item.filePath, effectiveCursor, item, itemForceFull);
        if (!res) {
          failedFileKeys.add(fileKey);
          skippedFiles.push({ agent: adapter.id, filePath: item.filePath });
          if (prevSid) failedSessionKeys.add(sessionKey(adapter.id, prevSid));
          for (const lid of legacyIds) failedSessionKeys.add(sessionKey(adapter.id, lid));
          if (item.sessionId) failedSessionKeys.add(sessionKey(adapter.id, item.sessionId));
          return;
        }
        if (res.unchanged) return;

        changedFiles += 1;
        for (const e of res.events) newEvents.push(e);
        state.files[fileKey] = res.cursor;

        const newSid = res.cursor.sessionId || item.sessionId;
        const newSk = sessionKey(adapter.id, newSid);
        if (itemForceFull) {
          fullScannedFileKeys.add(fileKey);
          replaceSessionKeys.add(newSk);
          if (prevSid) replaceSessionKeys.add(sessionKey(adapter.id, prevSid));
          for (const lid of legacyIds) replaceSessionKeys.add(sessionKey(adapter.id, lid));
          const list = rebuiltSessionMeta.get(newSk) || [];
          list.push({
            agent: adapter.id,
            sessionId: newSid,
            app: res.cursor.app || item.app || adapter.id,
            title: res.cursor.title,
            parentSessionId: res.cursor.parentSessionId || item.parentSessionId,
            lastModel: res.cursor.lastModel,
            firstTs: res.cursor.firstTs,
            lastTs: res.cursor.lastTs,
          });
          rebuiltSessionMeta.set(newSk, list);
        } else {
          mergeSessionMeta(state, {
            agent: adapter.id,
            sessionId: newSid,
            app: res.cursor.app || item.app || adapter.id,
            title: res.cursor.title,
            parentSessionId: res.cursor.parentSessionId || item.parentSessionId,
            lastModel: res.cursor.lastModel,
            firstTs: res.cursor.firstTs,
            lastTs: res.cursor.lastTs,
          });
        }
      };

      for (const entry of discovered) {
        const { adapter, item } = entry;
        const fileKey = canonicalFileKey(item.filePath);
        const prevCursor = state.files[fileKey];
        const prevSid = prevCursor?.agent === adapter.id ? prevCursor.sessionId || '' : '';
        const itemInUpgrade =
          !forceFullRescan &&
          (needsParserUpgrade(adapter, prevCursor) ||
            (prevSid && upgradeSessionKeys.has(sessionKey(adapter.id, prevSid))) ||
            (item.sessionId && upgradeSessionKeys.has(sessionKey(adapter.id, item.sessionId))));
        scanDiscoveredItem(entry, Boolean(forceFullRescan || itemInUpgrade));
      }

      // Convergent closure: if an upgraded file resolved to a sessionId already shared by
      // another live sibling file that wasn't full-scanned yet, rescan that sibling too so
      // `replaceSessionKeys` never drops a live sibling's events.
      if (!forceFullRescan && replaceSessionKeys.size > 0) {
        let addedSibling = true;
        while (addedSibling) {
          addedSibling = false;
          for (const entry of discovered) {
            const fk = canonicalFileKey(entry.item.filePath);
            if (fullScannedFileKeys.has(fk) || failedFileKeys.has(fk)) continue;
            const cur = state.files[fk];
            const curSid = cur?.agent === entry.adapter.id ? cur.sessionId || '' : '';
            const hitsReplaced =
              (curSid && replaceSessionKeys.has(sessionKey(entry.adapter.id, curSid))) ||
              (entry.item.sessionId && replaceSessionKeys.has(sessionKey(entry.adapter.id, entry.item.sessionId)));
            if (hitsReplaced) {
              addedSibling = true;
              scanDiscoveredItem(entry, true);
            }
          }
        }
      }

      // Never purge persisted events for a session whose live file failed to read in this run,
      // while still merging any fresh metadata recovered from healthy sibling files.
      for (const fsk of failedSessionKeys) {
        replaceSessionKeys.delete(fsk);
        const metas = rebuiltSessionMeta.get(fsk);
        if (metas && metas.length > 0) {
          for (const m of metas) mergeSessionMeta(state, m);
        }
      }

      // Refresh session metadata cleanly for fully rebuilt / upgraded sessions
      for (const sk of replaceSessionKeys) {
        const metas = rebuiltSessionMeta.get(sk);
        if (metas && metas.length > 0) {
          delete state.sessions[sk];
          for (const m of metas) mergeSessionMeta(state, m);
        } else {
          // A previously misattributed sessionKey vacated during upgrade with zero remaining live files
          delete state.sessions[sk];
        }
      }

      if (forceFullRescan || upgradedAny) {
        compactEventsPreservingArchived(dataDir, newEvents, { replaceSessionKeys });
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
