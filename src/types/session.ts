export const SCHEMA_VERSION = 1;

export type RecordingStatus =
  | 'idle'
  | 'initializing'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'interrupted'
  | 'failed';

export interface CollectorStatus {
  video: 'idle' | 'active' | 'paused' | 'stopped' | 'error';
  network: 'idle' | 'active' | 'detached' | 'error';
  console: 'idle' | 'active' | 'detached' | 'error';
  errors: 'idle' | 'active' | 'detached' | 'error';
}

export interface Session {
  id: string;
  schemaVersion: number;
  name: string;
  description?: string;
  status: Exclude<RecordingStatus, 'idle' | 'initializing' | 'finalizing'>;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  tab: {
    id: number;
    initialUrl: string;
    initialTitle: string;
  };
  video: {
    mimeType: string;
    durationMs: number;
    totalBytes: number;
    chunkCount: number;
  };
  statistics: {
    networkRequests: number;
    consoleMessages: number;
    errors: number;
  };
  imported?: boolean;
}

export type EventType = 'network' | 'console' | 'exception' | 'navigation' | 'lifecycle';

export interface SessionEvent<T = unknown> {
  id: string;
  sessionId: string;
  timestamp: number;
  relativeTimeMs: number;
  type: EventType;
  payload: T;
}

export interface NetworkEventPayload {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  resourceType?: string;
  failureReason?: string;
  encodedDataLength?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responseBodyBase64?: boolean;
  redirectFrom?: string;
}

export interface ConsoleEventPayload {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug';
  message: string;
  args?: string[];
  sourceUrl?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: string;
}

export interface ExceptionEventPayload {
  message: string;
  sourceUrl?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: string;
  unhandledRejection?: boolean;
}

export interface VideoChunk {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  relativeTimeMs: number;
  blob: Blob;
  sizeBytes: number;
}

export interface ExtensionSettings {
  id: 'default';
  captureAudio: boolean;
  captureNetworkBodies: boolean;
  maxBodySizeKb: number;
  redactHeaders: boolean;
  redactQueryParams: boolean;
  blockedDomains: string[];
  maxSessionSizeMb: number;
  chunkTimesliceMs: number;
}

export interface ActiveRecordingState {
  status: RecordingStatus;
  sessionId: string | null;
  tabId: number | null;
  tabTitle: string;
  tabUrl: string;
  startedAt: number;
  pausedAt: number | null;
  accumulatedPauseMs: number;
  collectors: CollectorStatus;
  counters: {
    network: number;
    console: number;
    errors: number;
    chunks: number;
    bytes: number;
  };
  lastError?: string;
}
