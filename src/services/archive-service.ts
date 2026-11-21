import JSZip from 'jszip';
import { db } from '../database/db';
import {
  SCHEMA_VERSION,
  type ConsoleEventPayload,
  type ExceptionEventPayload,
  type NetworkEventPayload,
  type Session,
  type SessionEvent,
} from '../types/session';

export type ExportFormat =
  | 'full-zip'
  | 'video-webm'
  | 'logs-json'
  | 'logs-txt'
  | 'network-json'
  | 'errors-json';

function formatTimestampOffset(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  const millis = String(ms % 1000).padStart(3, '0');
  return `${mins}:${secs}.${millis}`;
}

export async function exportSessionVideo(sessionId: string): Promise<{ blob: Blob; filename: string }> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const chunks = await db.videoChunks.where('sessionId').equals(sessionId).sortBy('sequence');
  if (chunks.length === 0) {
    throw new Error('No video recording available for this session.');
  }

  const safeName = session.name.replace(/[^a-z0-9-_]+/gi, '_');
  const blob = new Blob(
    chunks.map((c) => c.blob),
    { type: session.video.mimeType || 'video/webm' }
  );
  return { blob, filename: `${safeName}.webm` };
}

export async function exportSessionLogsJson(
  sessionId: string,
  filterType?: 'network' | 'console' | 'exception'
): Promise<{ blob: Blob; filename: string }> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const allEvents = await db.events.where('sessionId').equals(sessionId).sortBy('relativeTimeMs');
  const events = filterType ? allEvents.filter((e) => e.type === filterType) : allEvents;
  const safeName = session.name.replace(/[^a-z0-9-_]+/gi, '_');

  const payload = {
    session: {
      id: session.id,
      name: session.name,
      startedAt: new Date(session.startedAt).toISOString(),
      durationMs: session.durationMs,
      url: session.tab.initialUrl,
      title: session.tab.initialTitle,
      statistics: session.statistics,
    },
    exportedAt: new Date().toISOString(),
    filter: filterType || 'all',
    eventCount: events.length,
    events,
  };

  const suffix = filterType ? `_${filterType}` : '_full_logs';
  return {
    blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    filename: `${safeName}${suffix}.json`,
  };
}

export async function exportSessionLogsTxt(sessionId: string): Promise<{ blob: Blob; filename: string }> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const events = await db.events.where('sessionId').equals(sessionId).sortBy('relativeTimeMs');
  const safeName = session.name.replace(/[^a-z0-9-_]+/gi, '_');

  const lines: string[] = [
    `====================================================================`,
    `SESSION RECORDER DIAGNOSTIC LOG`,
    `====================================================================`,
    `Session:   ${session.name}`,
    `URL:       ${session.tab.initialUrl}`,
    `Started:   ${new Date(session.startedAt).toISOString()}`,
    `Duration:  ${(session.durationMs / 1000).toFixed(2)}s`,
    `Summary:   ${session.statistics.networkRequests} network | ${session.statistics.consoleMessages} console | ${session.statistics.errors} errors`,
    `====================================================================`,
    ``,
  ];

  for (const ev of events) {
    const ts = `[${formatTimestampOffset(ev.relativeTimeMs)}]`;
    if (ev.type === 'network') {
      const p = ev.payload as NetworkEventPayload;
      const status = p.failureReason ? `FAILED (${p.failureReason})` : `${p.status ?? 'PENDING'}`;
      const dur = p.durationMs !== undefined ? ` (${p.durationMs}ms)` : '';
      lines.push(`${ts} [NETWORK] ${p.method} ${status} ${p.url}${dur}`);
      if (p.requestBody) lines.push(`    Request Body: ${p.requestBody}`);
      if (p.responseBody) lines.push(`    Response Body: ${p.responseBody}`);
    } else if (ev.type === 'console') {
      const p = ev.payload as ConsoleEventPayload;
      lines.push(`${ts} [CONSOLE:${p.level.toUpperCase()}] ${p.message}`);
      if (p.sourceUrl) lines.push(`    at ${p.sourceUrl}:${p.lineNumber ?? 0}:${p.columnNumber ?? 0}`);
    } else if (ev.type === 'exception') {
      const p = ev.payload as ExceptionEventPayload;
      lines.push(`${ts} [EXCEPTION] ${p.message}`);
      if (p.stackTrace) {
        lines.push(
          p.stackTrace
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n')
        );
      }
    }
  }

  return {
    blob: new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }),
    filename: `${safeName}_full_logs.txt`,
  };
}

export async function exportSessionAsZip(sessionId: string): Promise<Blob> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  const events = await db.events.where('sessionId').equals(sessionId).sortBy('relativeTimeMs');
  const chunks = await db.videoChunks.where('sessionId').equals(sessionId).sortBy('sequence');

  const zip = new JSZip();

  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        format: 'session-recorder-archive',
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        sessionId: session.id,
      },
      null,
      2
    )
  );

  zip.file('metadata.json', JSON.stringify(session, null, 2));

  const networkEvents = events.filter((e) => e.type === 'network');
  const consoleEvents = events.filter((e) => e.type === 'console');
  const errorEvents = events.filter((e) => e.type === 'exception');

  zip.file('network/events.json', JSON.stringify(networkEvents, null, 2));
  zip.file('console/events.json', JSON.stringify(consoleEvents, null, 2));
  zip.file('errors/events.json', JSON.stringify(errorEvents, null, 2));

  if (chunks.length > 0) {
    const combinedBlob = new Blob(
      chunks.map((c) => c.blob),
      { type: session.video.mimeType || 'video/webm' }
    );
    zip.file('recording/video.webm', combinedBlob);
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

function validateSafeZipPaths(zip: JSZip) {
  for (const filePath of Object.keys(zip.files)) {
    if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\\')) {
      throw new Error(`Security violation: unsafe archive path "${filePath}"`);
    }
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.js') || lower.endsWith('.exe')) {
      throw new Error(`Security violation: disallowed executable file "${filePath}"`);
    }
  }
}

export async function importSessionFromZip(
  file: File,
  onProgress?: (percent: number, stage: string) => void
): Promise<Session> {
  onProgress?.(10, 'Reading archive...');
  const zip = await JSZip.loadAsync(file);

  validateSafeZipPaths(zip);

  const manifestFile = zip.file('manifest.json');
  const metadataFile = zip.file('metadata.json');
  if (!manifestFile || !metadataFile) {
    throw new Error('Invalid archive: missing manifest.json or metadata.json');
  }

  onProgress?.(25, 'Validating schema...');
  const manifest = JSON.parse(await manifestFile.async('string'));
  if (manifest.format !== 'session-recorder-archive') {
    throw new Error('Unsupported archive format.');
  }
  if (typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version: ${manifest.schemaVersion}`);
  }

  const rawMeta = JSON.parse(await metadataFile.async('string')) as Session;
  if (!rawMeta.id || !rawMeta.name || !rawMeta.startedAt) {
    throw new Error('Corrupted session metadata.');
  }

  const existing = await db.sessions.get(rawMeta.id);
  const targetSessionId = existing ? `${rawMeta.id}_imp_${Date.now()}` : rawMeta.id;

  onProgress?.(45, 'Extracting diagnostic events...');
  const parseEvents = async (path: string): Promise<SessionEvent[]> => {
    const f = zip.file(path);
    if (!f) return [];
    const parsed = JSON.parse(await f.async('string'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((ev, idx) => ({
      ...ev,
      id: `${targetSessionId}_${ev.type}_${idx}_${crypto.randomUUID().slice(0, 6)}`,
      sessionId: targetSessionId,
    }));
  };

  const [networkEvents, consoleEvents, errorEvents] = await Promise.all([
    parseEvents('network/events.json'),
    parseEvents('console/events.json'),
    parseEvents('errors/events.json'),
  ]);
  const allEvents = [...networkEvents, ...consoleEvents, ...errorEvents];

  onProgress?.(70, 'Extracting video recording...');
  const videoFile = zip.file('recording/video.webm');
  const videoBlob = videoFile ? await videoFile.async('blob') : null;

  const importedSession: Session = {
    ...rawMeta,
    id: targetSessionId,
    name: existing ? `${rawMeta.name} (Imported)` : rawMeta.name,
    imported: true,
    video: {
      ...rawMeta.video,
      totalBytes: videoBlob ? videoBlob.size : 0,
      chunkCount: videoBlob ? 1 : 0,
    },
    statistics: {
      networkRequests: networkEvents.length,
      consoleMessages: consoleEvents.length,
      errors: errorEvents.length,
    },
  };

  onProgress?.(90, 'Persisting to local database...');
  await db.transaction('rw', db.sessions, db.events, db.videoChunks, async () => {
    await db.sessions.put(importedSession);
    if (allEvents.length > 0) {
      await db.events.bulkPut(allEvents);
    }
    if (videoBlob && videoBlob.size > 0) {
      await db.videoChunks.put({
        id: `${targetSessionId}_chunk_0`,
        sessionId: targetSessionId,
        sequence: 0,
        timestamp: importedSession.startedAt,
        relativeTimeMs: 0,
        blob: new Blob([videoBlob], { type: importedSession.video.mimeType || 'video/webm' }),
        sizeBytes: videoBlob.size,
      });
    }
  });

  onProgress?.(100, 'Import complete');
  return importedSession;
}
