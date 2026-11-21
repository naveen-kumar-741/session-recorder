import Dexie, { type Table } from 'dexie';
import type {
  ExtensionSettings,
  Session,
  SessionEvent,
  VideoChunk,
} from '../types/session';

export class SessionRecorderDB extends Dexie {
  sessions!: Table<Session, string>;
  events!: Table<SessionEvent, string>;
  videoChunks!: Table<VideoChunk, string>;
  settings!: Table<ExtensionSettings, string>;

  constructor() {
    super('SessionRecorderDB');
    this.version(1).stores({
      sessions: 'id, status, startedAt, name',
      events: 'id, sessionId, timestamp, relativeTimeMs, type, [sessionId+type]',
      videoChunks: 'id, sessionId, sequence, [sessionId+sequence]',
      settings: 'id',
    });
  }
}

export const db = new SessionRecorderDB();

export const DEFAULT_SETTINGS: ExtensionSettings = {
  id: 'default',
  captureAudio: true,
  captureNetworkBodies: true,
  maxBodySizeKb: 256,
  redactHeaders: true,
  redactQueryParams: true,
  blockedDomains: [],
  maxSessionSizeMb: 500,
  chunkTimesliceMs: 2000,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const existing = await db.settings.get('default');
  if (existing) {
    return { ...DEFAULT_SETTINGS, ...existing };
  }
  await db.settings.put(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export async function updateSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const updated: ExtensionSettings = { ...current, ...patch, id: 'default' };
  await db.settings.put(updated);
  return updated;
}

export async function deleteSessionCompletely(sessionId: string): Promise<void> {
  await db.transaction('rw', db.sessions, db.events, db.videoChunks, async () => {
    await db.videoChunks.where('sessionId').equals(sessionId).delete();
    await db.events.where('sessionId').equals(sessionId).delete();
    await db.sessions.delete(sessionId);
  });
}

export async function getStorageStats(): Promise<{
  totalSessions: number;
  totalDurationMs: number;
  totalVideoBytes: number;
  quotaBytes?: number;
  usageBytes?: number;
}> {
  const sessions = await db.sessions.toArray();
  const totalSessions = sessions.length;
  const totalDurationMs = sessions.reduce((acc, s) => acc + (s.durationMs || 0), 0);
  const totalVideoBytes = sessions.reduce((acc, s) => acc + (s.video?.totalBytes || 0), 0);

  let quotaBytes: number | undefined;
  let usageBytes: number | undefined;
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    quotaBytes = est.quota;
    usageBytes = est.usage;
  }

  return { totalSessions, totalDurationMs, totalVideoBytes, quotaBytes, usageBytes };
}
