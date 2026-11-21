import JSZip from 'jszip';
import { db } from '../database/db';
import { SCHEMA_VERSION, type Session, type SessionEvent } from '../types/session';

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
