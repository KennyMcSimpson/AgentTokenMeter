import { existsSync } from 'node:fs';
import { detectAdapterForPath, getAdapter, getAdapters, getEnabledAgentIds } from '../adapters/index.mjs';
import { canonicalFileKey, withLock } from './fs-utils.mjs';
import { getDataDir } from './pricing.mjs';
import {
  appendEventsByMonth,
  compactEventsPreservingArchived,
  mergeSessionMeta,
  readCursorsState,
  writeCursorsState,
} from './store.mjs';

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
      const res = adapter.scanDelta(filePath, state.files[fileKey], meta, false);
      if (!res || res.unchanged) {
        return { agent: adapter.id, added: 0, scanned: 1 };
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
      let changedFiles = 0;

      for (const { adapter, item } of discovered) {
        const fileKey = canonicalFileKey(item.filePath);
        const res = adapter.scanDelta(item.filePath, state.files[fileKey], item, forceFullRescan);
        if (!res || res.unchanged) continue;
        changedFiles += 1;
        for (const e of res.events) newEvents.push(e);
        state.files[fileKey] = res.cursor;
        mergeSessionMeta(state, {
          agent: adapter.id,
          sessionId: res.cursor.sessionId || item.sessionId,
          app: res.cursor.app || item.app || adapter.id,
          title: res.cursor.title,
          parentSessionId: res.cursor.parentSessionId || item.parentSessionId,
          lastModel: res.cursor.lastModel,
          firstTs: res.cursor.firstTs,
          lastTs: res.cursor.lastTs,
        });
      }

      if (forceFullRescan) {
        compactEventsPreservingArchived(dataDir, newEvents);
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
      };
    },
    lockOpts,
  );
}
