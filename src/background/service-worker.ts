import { db, getSettings } from '../database/db';
import {
  SCHEMA_VERSION,
  type ActiveRecordingState,
  type ConsoleEventPayload,
  type ExceptionEventPayload,
  type ExtensionSettings,
  type NetworkEventPayload,
  type Session,
  type SessionEvent,
} from '../types/session';
import { isDomainBlocked, redactBody, redactHeaders, redactString, redactUrl } from '../utils/redaction';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

const INITIAL_STATE: ActiveRecordingState = {
  status: 'idle',
  sessionId: null,
  tabId: null,
  tabTitle: '',
  tabUrl: '',
  startedAt: 0,
  pausedAt: null,
  accumulatedPauseMs: 0,
  collectors: {
    video: 'idle',
    network: 'idle',
    console: 'idle',
    errors: 'idle',
  },
  counters: {
    network: 0,
    console: 0,
    errors: 0,
    chunks: 0,
    bytes: 0,
  },
};

let state: ActiveRecordingState = structuredClone(INITIAL_STATE);
let cachedSettings: ExtensionSettings | null = null;
let eventBuffer: SessionEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

interface PendingRequest {
  url: string;
  method: string;
  startedAt: number;
  relativeTimeMs: number;
  resourceType?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  redirectFrom?: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  encodedDataLength?: number;
  responseHeaders?: Record<string, string>;
}

const pendingRequests = new Map<string, PendingRequest>();
const recentErrorHashes = new Set<string>();

async function persistState() {
  await chrome.storage.session.set({ activeRecordingState: state });
  broadcastState();
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'RECORDING_STATE_UPDATED', payload: state }).catch(() => {});
}

async function restoreStateIfNeeded() {
  const stored = await chrome.storage.session.get('activeRecordingState');
  if (stored?.activeRecordingState) {
    state = stored.activeRecordingState;
  }
}

function getRelativeTimeMs(now = Date.now()): number {
  if (!state.startedAt) return 0;
  const activePause = state.pausedAt ? now - state.pausedAt : 0;
  return Math.max(0, now - state.startedAt - state.accumulatedPauseMs - activePause);
}

function enqueueEvent(event: SessionEvent) {
  if (state.status !== 'recording') return;
  eventBuffer.push(event);
}

async function flushEventBuffer() {
  if (eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0, eventBuffer.length);
  try {
    await db.events.bulkPut(batch);
  } catch (err) {
    console.error('Failed to flush event batch to IndexedDB', err);
  }
}

function startEventFlusher() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    void flushEventBuffer();
  }, 1000);
}

function stopEventFlusher() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Record active browser tab video and audio stream via MediaRecorder.',
  });
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

async function attachDebugger(tabId: number) {
  const target: chrome.debugger.Debuggee = { tabId };
  await chrome.debugger.attach(target, '1.3');
  await chrome.debugger.sendCommand(target, 'Network.enable', {
    maxTotalBufferSize: 10 * 1024 * 1024,
    maxResourceBufferSize: 2 * 1024 * 1024,
  });
  await chrome.debugger.sendCommand(target, 'Runtime.enable');
  await chrome.debugger.sendCommand(target, 'Log.enable');
}

async function detachDebugger(tabId: number) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached
  }
}

async function startRecording(tabId: number) {
  if (state.status === 'recording' || state.status === 'paused' || state.status === 'initializing') {
    throw new Error('A recording is already in progress.');
  }

  cachedSettings = await getSettings();
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('Cannot record internal Chrome pages. Switch to a standard web page.');
  }

  if (isDomainBlocked(tab.url, cachedSettings.blockedDomains)) {
    throw new Error('This domain is blocked in privacy settings.');
  }

  const sessionId = `sess_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();

  state = {
    status: 'initializing',
    sessionId,
    tabId,
    tabTitle: tab.title || 'Untitled Tab',
    tabUrl: redactUrl(tab.url, cachedSettings.redactQueryParams),
    startedAt,
    pausedAt: null,
    accumulatedPauseMs: 0,
    collectors: {
      video: 'idle',
      network: 'idle',
      console: 'idle',
      errors: 'idle',
    },
    counters: { network: 0, console: 0, errors: 0, chunks: 0, bytes: 0 },
  };
  await persistState();

  const initialSession: Session = {
    id: sessionId,
    schemaVersion: SCHEMA_VERSION,
    name: `${tab.title || 'Session'} — ${new Date(startedAt).toLocaleTimeString()}`,
    status: 'recording',
    startedAt,
    durationMs: 0,
    tab: {
      id: tabId,
      initialUrl: state.tabUrl,
      initialTitle: state.tabTitle,
    },
    video: {
      mimeType: 'video/webm',
      durationMs: 0,
      totalBytes: 0,
      chunkCount: 0,
    },
    statistics: {
      networkRequests: 0,
      consoleMessages: 0,
      errors: 0,
    },
  };
  await db.sessions.put(initialSession);

  try {
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError || !id) {
          reject(new Error(chrome.runtime.lastError?.message || 'Failed to get tab stream ID'));
        } else {
          resolve(id);
        }
      });
    });

    await ensureOffscreenDocument();
    const offscreenRes = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'OFFSCREEN_START',
      payload: {
        sessionId,
        streamId,
        captureAudio: cachedSettings.captureAudio,
        startedAt,
        timesliceMs: cachedSettings.chunkTimesliceMs,
      },
    });

    if (!offscreenRes?.ok) {
      throw new Error(offscreenRes?.error || 'Offscreen capture failed to start');
    }
    state.collectors.video = 'active';

    try {
      await attachDebugger(tabId);
      state.collectors.network = 'active';
      state.collectors.console = 'active';
      state.collectors.errors = 'active';
    } catch (cdpErr) {
      console.warn('CDP attachment failed, continuing video-only:', cdpErr);
      state.collectors.network = 'detached';
      state.collectors.console = 'detached';
      state.collectors.errors = 'detached';
    }

    pendingRequests.clear();
    recentErrorHashes.clear();
    startEventFlusher();

    state.status = 'recording';
    await persistState();
  } catch (err) {
    state.status = 'failed';
    state.lastError = (err as Error).message;
    await db.sessions.update(sessionId, { status: 'failed', endedAt: Date.now() });
    await persistState();
    throw err;
  }
}

async function pauseRecording() {
  if (state.status !== 'recording') return;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_PAUSE' });
  state.status = 'paused';
  state.pausedAt = Date.now();
  state.collectors.video = 'paused';
  await persistState();
}

async function resumeRecording() {
  if (state.status !== 'paused') return;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_RESUME' });
  if (state.pausedAt) {
    state.accumulatedPauseMs += Date.now() - state.pausedAt;
    state.pausedAt = null;
  }
  state.status = 'recording';
  state.collectors.video = 'active';
  await persistState();
}

async function stopRecording(finalStatus: 'completed' | 'interrupted' = 'completed') {
  if (state.status === 'idle' || !state.sessionId) return;

  const sessionId = state.sessionId;
  const tabId = state.tabId;
  const endedAt = Date.now();
  const durationMs = getRelativeTimeMs(endedAt);

  state.status = 'finalizing';
  await persistState();

  stopEventFlusher();
  await flushEventBuffer();

  let videoStats = {
    totalBytes: state.counters.bytes,
    chunkCount: state.counters.chunks,
    mimeType: 'video/webm',
  };

  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_STOP' });
    if (res?.stats) {
      videoStats = res.stats;
    }
  } catch {
    // Offscreen may already be closed
  }

  await closeOffscreenDocument();
  if (tabId !== null) {
    await detachDebugger(tabId);
  }

  await db.sessions.update(sessionId, {
    status: finalStatus,
    endedAt,
    durationMs,
    video: {
      mimeType: videoStats.mimeType,
      durationMs,
      totalBytes: videoStats.totalBytes,
      chunkCount: videoStats.chunkCount,
    },
    statistics: {
      networkRequests: state.counters.network,
      consoleMessages: state.counters.console,
      errors: state.counters.errors,
    },
  });

  pendingRequests.clear();
  state = structuredClone(INITIAL_STATE);
  await persistState();
}

function finalizeNetworkEvent(sessionId: string, requestId: string, req: PendingRequest, responseBody?: string, responseBodyBase64?: boolean) {
  const now = Date.now();
  const payload: NetworkEventPayload = {
    requestId,
    url: req.url,
    method: req.method,
    status: req.status,
    statusText: req.statusText,
    durationMs: req.durationMs,
    resourceType: req.resourceType,
    encodedDataLength: req.encodedDataLength,
    requestHeaders: req.requestHeaders,
    responseHeaders: req.responseHeaders,
    requestBody: req.requestBody,
    responseBody,
    responseBodyBase64,
    redirectFrom: req.redirectFrom,
  };

  state.counters.network += 1;
  enqueueEvent({
    id: `${sessionId}_net_${requestId}_${now}`,
    sessionId,
    timestamp: now,
    relativeTimeMs: req.relativeTimeMs,
    type: 'network',
    payload,
  });
}

chrome.debugger.onEvent.addListener((source, method, params: any) => {
  if (!state.sessionId || source.tabId !== state.tabId || state.status !== 'recording') return;

  const sessionId = state.sessionId;
  const tabId = state.tabId;
  const now = Date.now();
  const relativeTimeMs = getRelativeTimeMs(now);
  const redactHdrs = cachedSettings?.redactHeaders ?? true;
  const redactParams = cachedSettings?.redactQueryParams ?? true;
  const captureBodies = cachedSettings?.captureNetworkBodies ?? true;
  const maxBodyBytes = (cachedSettings?.maxBodySizeKb ?? 256) * 1024;

  if (method === 'Network.requestWillBeSent') {
    const cleanUrl = redactUrl(params.request.url, redactParams);
    const prev = pendingRequests.get(params.requestId);
    const rawPostData: string | undefined = params.request.postData;
    const sanitizedRequestBody =
      captureBodies && rawPostData
        ? redactBody(rawPostData, maxBodyBytes, redactHdrs)
        : undefined;

    pendingRequests.set(params.requestId, {
      url: cleanUrl,
      method: params.request.method,
      startedAt: now,
      relativeTimeMs,
      resourceType: params.type,
      requestHeaders: redactHeaders(params.request.headers, redactHdrs),
      requestBody: sanitizedRequestBody,
      redirectFrom: params.redirectResponse ? prev?.url : undefined,
    });
  } else if (method === 'Network.responseReceived') {
    const req = pendingRequests.get(params.requestId);
    if (!req) return;
    req.status = params.response.status;
    req.statusText = params.response.statusText;
    req.durationMs = Math.max(0, now - req.startedAt);
    req.resourceType = params.type || req.resourceType;
    req.encodedDataLength = params.response.encodedDataLength;
    req.responseHeaders = redactHeaders(params.response.headers, redactHdrs);
  } else if (method === 'Network.loadingFinished') {
    const req = pendingRequests.get(params.requestId);
    if (!req) return;
    pendingRequests.delete(params.requestId);

    const textResourceTypes = new Set(['Fetch', 'XHR', 'Document', 'Script', 'Stylesheet', 'Other']);
    const shouldFetchBody =
      captureBodies &&
      tabId !== null &&
      (!req.resourceType || textResourceTypes.has(req.resourceType));

    if (!shouldFetchBody) {
      finalizeNetworkEvent(sessionId, params.requestId, req);
      return;
    }

    chrome.debugger
      .sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId })
      .then((res: any) => {
        if (res?.body) {
          const cleanBody = res.base64Encoded
            ? '[Binary / Base64 Response]'
            : redactBody(res.body, maxBodyBytes, redactHdrs);
          finalizeNetworkEvent(sessionId, params.requestId, req, cleanBody, Boolean(res.base64Encoded));
        } else {
          finalizeNetworkEvent(sessionId, params.requestId, req);
        }
      })
      .catch(() => {
        finalizeNetworkEvent(sessionId, params.requestId, req);
      });
  } else if (method === 'Network.loadingFailed') {
    const req = pendingRequests.get(params.requestId);
    pendingRequests.delete(params.requestId);

    const payload: NetworkEventPayload = {
      requestId: params.requestId,
      url: req?.url || '[Unknown URL]',
      method: req?.method || 'GET',
      durationMs: req ? Math.max(0, now - req.startedAt) : undefined,
      resourceType: params.type || req?.resourceType,
      failureReason: params.errorText || 'Network failure',
      requestHeaders: req?.requestHeaders,
      requestBody: req?.requestBody,
    };

    state.counters.network += 1;
    enqueueEvent({
      id: `${sessionId}_netfail_${params.requestId}_${now}`,
      sessionId,
      timestamp: now,
      relativeTimeMs: req?.relativeTimeMs ?? relativeTimeMs,
      type: 'network',
      payload,
    });
  } else if (method === 'Runtime.consoleAPICalled') {
    const argsText = (params.args || []).map((arg: any) => {
      if (arg.value !== undefined) return redactString(String(arg.value));
      if (arg.description) return redactString(String(arg.description));
      return `[${arg.type}]`;
    });

    const topFrame = params.stackTrace?.callFrames?.[0];
    const levelMap: Record<string, ConsoleEventPayload['level']> = {
      log: 'log',
      info: 'info',
      warning: 'warning',
      error: 'error',
      debug: 'debug',
      assert: 'error',
      table: 'log',
    };

    const payload: ConsoleEventPayload = {
      level: levelMap[params.type] || 'log',
      message: argsText.join(' '),
      args: argsText,
      sourceUrl: topFrame?.url ? redactUrl(topFrame.url, redactParams) : undefined,
      lineNumber: topFrame?.lineNumber,
      columnNumber: topFrame?.columnNumber,
      stackTrace: params.stackTrace?.callFrames
        ?.map((f: any) => `at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
        .join('\n'),
    };

    state.counters.console += 1;
    enqueueEvent({
      id: `${sessionId}_con_${crypto.randomUUID()}`,
      sessionId,
      timestamp: now,
      relativeTimeMs,
      type: 'console',
      payload,
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails;
    const msg = redactString(
      details?.exception?.description || details?.text || 'Uncaught runtime exception'
    );
    const dedupeKey = `${msg}:${details?.url}:${details?.lineNumber}`;
    if (recentErrorHashes.has(dedupeKey)) return;
    recentErrorHashes.add(dedupeKey);
    setTimeout(() => recentErrorHashes.delete(dedupeKey), 3000);

    const payload: ExceptionEventPayload = {
      message: msg,
      sourceUrl: details?.url ? redactUrl(details.url, redactParams) : undefined,
      lineNumber: details?.lineNumber,
      columnNumber: details?.columnNumber,
      stackTrace: details?.stackTrace?.callFrames
        ?.map((f: any) => `at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`)
        .join('\n'),
    };

    state.counters.errors += 1;
    enqueueEvent({
      id: `${sessionId}_err_${crypto.randomUUID()}`,
      sessionId,
      timestamp: now,
      relativeTimeMs,
      type: 'exception',
      payload,
    });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === state.tabId && (state.status === 'recording' || state.status === 'paused')) {
    state.collectors.network = 'detached';
    state.collectors.console = 'detached';
    state.collectors.errors = 'detached';
    void persistState();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId && (state.status === 'recording' || state.status === 'paused')) {
    void stopRecording('interrupted');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;

  (async () => {
    await restoreStateIfNeeded();

    try {
      switch (message.type) {
        case 'GET_RECORDING_STATE':
          sendResponse({ ok: true, state });
          break;
        case 'START_RECORDING':
          await startRecording(message.tabId);
          sendResponse({ ok: true, state });
          break;
        case 'PAUSE_RECORDING':
          await pauseRecording();
          sendResponse({ ok: true, state });
          break;
        case 'RESUME_RECORDING':
          await resumeRecording();
          sendResponse({ ok: true, state });
          break;
        case 'STOP_RECORDING':
          await stopRecording('completed');
          sendResponse({ ok: true, state });
          break;
        case 'OFFSCREEN_CHUNK_SAVED': {
          state.counters.chunks += 1;
          state.counters.bytes = message.payload.totalBytes;

          const maxBytes = (cachedSettings?.maxSessionSizeMb || 500) * 1024 * 1024;
          if (state.counters.bytes >= maxBytes) {
            await stopRecording('interrupted');
          } else {
            await persistState();
          }
          sendResponse({ ok: true });
          break;
        }
        case 'OFFSCREEN_STREAM_ENDED':
          await stopRecording('interrupted');
          sendResponse({ ok: true });
          break;
        case 'OFFSCREEN_RECORDER_ERROR':
          state.lastError = message.payload.error;
          await stopRecording('interrupted');
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err as Error).message });
    }
  })();

  return true;
});
