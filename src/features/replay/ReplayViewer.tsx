import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileCode,
  FileText,
  Film,
  Package,
  Pause,
  Play,
  Search,
  X,
} from 'lucide-react';
import { db } from '../../database/db';
import {
  exportSessionAsZip,
  exportSessionLogsJson,
  exportSessionLogsTxt,
  exportSessionVideo,
  type ExportFormat,
} from '../../services/archive-service';
import type {
  ConsoleEventPayload,
  ExceptionEventPayload,
  NetworkEventPayload,
  Session,
  SessionEvent,
} from '../../types/session';

interface ReplayViewerProps {
  sessionId: string;
  onBack: () => void;
}

function tryPrettyJson(raw?: string): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded cursor-pointer"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function NetworkInspectorDrawer({
  event,
  onClose,
}: {
  event: SessionEvent<NetworkEventPayload>;
  onClose: () => void;
}) {
  const [subTab, setSubTab] = useState<'headers' | 'payload' | 'response'>('headers');
  const p = event.payload;

  return (
    <div className="border-t border-slate-200 bg-slate-50 flex flex-col h-1/2 min-h-[240px]">
      <div className="flex items-center justify-between px-3 py-2 bg-white border-b border-slate-200">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs font-bold text-slate-900">{p.method}</span>
          <span
            className={`font-mono text-xs font-semibold ${
              p.failureReason || (p.status && p.status >= 400) ? 'text-red-600' : 'text-emerald-700'
            }`}
          >
            {p.failureReason ? 'FAILED' : p.status}
          </span>
          <span className="font-mono text-xs text-slate-600 truncate" title={p.url}>
            {p.url}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
          title="Close inspector"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Inspector Sub-tabs */}
      <div className="flex items-center gap-1 px-3 py-1.5 bg-slate-100 border-b border-slate-200 text-xs">
        {(
          [
            { id: 'headers', label: 'Headers' },
            { id: 'payload', label: `Payload${p.requestBody ? ' •' : ''}` },
            { id: 'response', label: `Response${p.responseBody ? ' •' : ''}` },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${
              subTab === t.id
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Inspector Content */}
      <div className="flex-1 overflow-y-auto p-3 text-xs font-mono space-y-3">
        {subTab === 'headers' && (
          <>
            <div className="bg-white border border-slate-200 rounded p-2.5 space-y-1">
              <div className="font-sans font-semibold text-[11px] text-slate-700 mb-1.5">General</div>
              <div><span className="text-slate-500">Request URL:</span> <span className="break-all">{p.url}</span></div>
              <div><span className="text-slate-500">Request Method:</span> {p.method}</div>
              {p.status !== undefined && (
                <div><span className="text-slate-500">Status Code:</span> {p.status} {p.statusText}</div>
              )}
              {p.durationMs !== undefined && (
                <div><span className="text-slate-500">Duration:</span> {p.durationMs} ms</div>
              )}
              {p.resourceType && (
                <div><span className="text-slate-500">Resource Type:</span> {p.resourceType}</div>
              )}
              {p.failureReason && (
                <div className="text-red-600"><span className="text-slate-500">Failure Reason:</span> {p.failureReason}</div>
              )}
              {p.redirectFrom && (
                <div><span className="text-slate-500">Redirected From:</span> {p.redirectFrom}</div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded p-2.5">
              <div className="font-sans font-semibold text-[11px] text-slate-700 mb-1.5">Response Headers</div>
              {p.responseHeaders && Object.keys(p.responseHeaders).length > 0 ? (
                <div className="space-y-1">
                  {Object.entries(p.responseHeaders).map(([k, v]) => (
                    <div key={k} className="break-all">
                      <span className="text-slate-500">{k}:</span> {v}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="font-sans text-slate-400">No response headers captured.</div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded p-2.5">
              <div className="font-sans font-semibold text-[11px] text-slate-700 mb-1.5">Request Headers</div>
              {p.requestHeaders && Object.keys(p.requestHeaders).length > 0 ? (
                <div className="space-y-1">
                  {Object.entries(p.requestHeaders).map(([k, v]) => (
                    <div key={k} className="break-all">
                      <span className="text-slate-500">{k}:</span> {v}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="font-sans text-slate-400">No request headers captured.</div>
              )}
            </div>
          </>
        )}

        {subTab === 'payload' && (
          <div className="bg-white border border-slate-200 rounded p-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="font-sans font-semibold text-[11px] text-slate-700">Request Payload</span>
              {p.requestBody && <CopyButton text={tryPrettyJson(p.requestBody)} />}
            </div>
            {p.requestBody ? (
              <pre className="whitespace-pre-wrap break-all text-[11px] text-slate-800 bg-slate-50 p-2 rounded border border-slate-100">
                {tryPrettyJson(p.requestBody)}
              </pre>
            ) : (
              <div className="font-sans text-slate-400">No request payload for this call.</div>
            )}
          </div>
        )}

        {subTab === 'response' && (
          <div className="bg-white border border-slate-200 rounded p-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="font-sans font-semibold text-[11px] text-slate-700">Response Body</span>
              {p.responseBody && <CopyButton text={tryPrettyJson(p.responseBody)} />}
            </div>
            {p.responseBody ? (
              <pre className="whitespace-pre-wrap break-all text-[11px] text-slate-800 bg-slate-50 p-2 rounded border border-slate-100">
                {tryPrettyJson(p.responseBody)}
              </pre>
            ) : (
              <div className="font-sans text-slate-400">
                No response body captured (either empty response, binary resource, or body capture disabled).
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ReplayViewer({ sessionId, onBack }: ReplayViewerProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [activeTab, setActiveTab] = useState<'all' | 'network' | 'console' | 'exception'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;

    async function load() {
      const s = await db.sessions.get(sessionId);
      if (s) setSession(s);

      const evs = await db.events.where('sessionId').equals(sessionId).sortBy('relativeTimeMs');
      setEvents(evs);

      const chunks = await db.videoChunks.where('sessionId').equals(sessionId).sortBy('sequence');
      if (chunks.length > 0 && !revoked) {
        const merged = new Blob(
          chunks.map((c) => c.blob),
          { type: s?.video.mimeType || 'video/webm' }
        );
        objectUrl = URL.createObjectURL(merged);
        setVideoUrl(objectUrl);
      }
    }

    void load();

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId]);

  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      if (activeTab !== 'all' && ev.type !== activeTab) return false;
      if (!searchQuery.trim()) return true;
      const text = JSON.stringify(ev.payload).toLowerCase();
      return text.includes(searchQuery.toLowerCase());
    });
  }, [events, activeTab, searchQuery]);

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedEventId) ?? null,
    [events, selectedEventId]
  );

  const seekTo = (ms: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, ms / 1000);
    setCurrentTimeMs(ms);
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      void videoRef.current.play();
    } else {
      videoRef.current.pause();
    }
  };

  const changeSpeed = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  const handleDownload = async (format: ExportFormat) => {
    if (!session) return;
    setExportOpen(false);
    const safeName = session.name.replace(/[^a-z0-9-_]+/gi, '_');
    const save = (blob: Blob, filename: string) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    };

    if (format === 'full-zip') {
      save(await exportSessionAsZip(session.id), `${safeName}.zip`);
    } else if (format === 'video-webm') {
      const { blob, filename } = await exportSessionVideo(session.id);
      save(blob, filename);
    } else if (format === 'logs-json') {
      const { blob, filename } = await exportSessionLogsJson(session.id);
      save(blob, filename);
    } else if (format === 'logs-txt') {
      const { blob, filename } = await exportSessionLogsTxt(session.id);
      save(blob, filename);
    } else if (format === 'network-json') {
      const { blob, filename } = await exportSessionLogsJson(session.id, 'network');
      save(blob, filename);
    } else if (format === 'errors-json') {
      const { blob, filename } = await exportSessionLogsJson(session.id, 'exception');
      save(blob, filename);
    }
  };

  const formatMs = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    const rem = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
    return `${m}:${s}.${rem}`;
  };

  if (!session) {
    return <div className="p-6 text-sm text-slate-600">Loading session...</div>;
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{session.name}</h2>
            <p className="text-xs text-slate-500">{session.tab.initialUrl}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <span>Network: {session.statistics.networkRequests}</span>
          <span>Console: {session.statistics.consoleMessages}</span>
          <span className="text-red-600 font-medium">Errors: {session.statistics.errors}</span>

          <div className="relative">
            <button
              onClick={() => setExportOpen((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900 text-white rounded hover:bg-slate-800 cursor-pointer font-medium"
            >
              <Download className="w-3.5 h-3.5" />
              Download
              <ChevronDown className="w-3 h-3" />
            </button>

            {exportOpen && (
              <div
                className="absolute right-0 mt-1 w-52 bg-white border border-slate-200 rounded-md shadow-lg py-1 z-30 text-left text-xs"
                onMouseLeave={() => setExportOpen(false)}
              >
                <button
                  onClick={() => void handleDownload('full-zip')}
                  className="w-full px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2 text-slate-800 cursor-pointer"
                >
                  <Package className="w-3.5 h-3.5 text-slate-500" />
                  Full Session (.zip)
                </button>
                <button
                  onClick={() => void handleDownload('video-webm')}
                  className="w-full px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2 text-slate-800 cursor-pointer"
                >
                  <Film className="w-3.5 h-3.5 text-blue-600" />
                  Video Alone (.webm)
                </button>
                <div className="my-1 border-t border-slate-100" />
                <button
                  onClick={() => void handleDownload('logs-json')}
                  className="w-full px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2 text-slate-800 cursor-pointer"
                >
                  <FileCode className="w-3.5 h-3.5 text-emerald-600" />
                  Full Logs (.json)
                </button>
                <button
                  onClick={() => void handleDownload('logs-txt')}
                  className="w-full px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2 text-slate-800 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5 text-slate-600" />
                  Full Logs (.txt)
                </button>
                <div className="my-1 border-t border-slate-100" />
                <button
                  onClick={() => void handleDownload('network-json')}
                  className="w-full px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2 text-slate-800 cursor-pointer"
                >
                  <FileCode className="w-3.5 h-3.5 text-indigo-600" />
                  Network Only (.json)
                </button>
                <button
                  onClick={() => void handleDownload('errors-json')}
                  className="w-full px-3 py-1.5 hover:bg-slate-50 flex items-center gap-2 text-slate-800 cursor-pointer"
                >
                  <FileCode className="w-3.5 h-3.5 text-red-600" />
                  Errors Only (.json)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 min-h-0">
        {/* Video Player Panel */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3">
          <div className="flex-1 bg-slate-950 rounded-md overflow-hidden flex items-center justify-center min-h-[260px]">
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                className="max-h-full max-w-full"
                onTimeUpdate={(e) => setCurrentTimeMs(e.currentTarget.currentTime * 1000)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
            ) : (
              <div className="text-xs text-slate-400">No video chunks available for this session.</div>
            )}
          </div>

          <div className="relative pt-2">
            <input
              type="range"
              min={0}
              max={session.durationMs || 1000}
              value={Math.min(currentTimeMs, session.durationMs || 1000)}
              onChange={(e) => seekTo(Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
            <div className="relative h-2 w-full">
              {events.map((ev) => {
                const pct = session.durationMs > 0 ? Math.min(100, (ev.relativeTimeMs / session.durationMs) * 100) : 0;
                const color =
                  ev.type === 'exception'
                    ? 'bg-red-500'
                    : ev.type === 'network'
                      ? 'bg-blue-500'
                      : 'bg-amber-500';
                return (
                  <span
                    key={ev.id}
                    title={`${ev.type} @ ${formatMs(ev.relativeTimeMs)}`}
                    style={{ left: `${pct}%` }}
                    className={`absolute top-0 w-1 h-2 rounded-xs ${color}`}
                  />
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2">
              <button
                onClick={togglePlay}
                className="inline-flex items-center gap-1.5 bg-slate-900 text-white text-xs font-medium px-3 py-1.5 rounded-md cursor-pointer"
              >
                {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <span className="font-mono text-xs text-slate-700">
                {formatMs(currentTimeMs)} / {formatMs(session.durationMs)}
              </span>
            </div>

            <div className="flex items-center gap-1">
              {[0.5, 1, 1.5, 2].map((speed) => (
                <button
                  key={speed}
                  onClick={() => changeSpeed(speed)}
                  className={`px-2 py-1 text-xs rounded cursor-pointer ${
                    playbackRate === speed
                      ? 'bg-blue-600 text-white font-medium'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Synchronized Diagnostic Explorer + Network Inspector */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg flex flex-col min-h-0 overflow-hidden">
          <div className="p-3 border-b border-slate-200 flex flex-col gap-2">
            <div className="flex gap-1">
              {(['all', 'network', 'console', 'exception'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-2.5 py-1 text-xs font-medium rounded capitalize cursor-pointer ${
                    activeTab === tab
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter URLs, payloads, responses, errors..."
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Event List */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {filteredEvents.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">No matching events.</div>
            ) : (
              filteredEvents.map((ev) => {
                const isNearCurrent = Math.abs(ev.relativeTimeMs - currentTimeMs) < 750;
                const isSelected = selectedEventId === ev.id;

                return (
                  <div
                    key={ev.id}
                    onClick={() => {
                      setSelectedEventId(isSelected ? null : ev.id);
                      seekTo(ev.relativeTimeMs);
                    }}
                    className={`p-2.5 text-xs cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-blue-50 border-l-2 border-blue-600'
                        : isNearCurrent
                          ? 'bg-amber-50/70'
                          : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        {ev.type === 'network' && (
                          isSelected ? <ChevronDown className="w-3.5 h-3.5 text-blue-600" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                        )}
                        <span
                          className={`uppercase text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                            ev.type === 'exception'
                              ? 'bg-red-100 text-red-700'
                              : ev.type === 'network'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {ev.type}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">
                        {formatMs(ev.relativeTimeMs)}
                      </span>
                    </div>

                    {ev.type === 'network' && (() => {
                      const p = ev.payload as NetworkEventPayload;
                      return (
                        <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-slate-800">
                          <div className="truncate">
                            <span className="font-semibold mr-1.5">{p.method}</span>
                            <span
                              className={`mr-1.5 ${
                                p.failureReason || (p.status && p.status >= 400)
                                  ? 'text-red-600 font-semibold'
                                  : 'text-emerald-700'
                              }`}
                            >
                              {p.failureReason ? 'ERR' : p.status}
                            </span>
                            <span>{p.url}</span>
                          </div>
                          {p.durationMs !== undefined && (
                            <span className="text-[10px] text-slate-400 shrink-0">{p.durationMs}ms</span>
                          )}
                        </div>
                      );
                    })()}

                    {ev.type === 'console' && (() => {
                      const p = ev.payload as ConsoleEventPayload;
                      return (
                        <div>
                          <div className="font-mono text-[11px] text-slate-800">
                            <span className="uppercase text-slate-500 mr-1.5">[{p.level}]</span>
                            {p.message}
                          </div>
                          {isSelected && p.stackTrace && (
                            <pre className="mt-2 p-2 bg-slate-900 text-slate-100 rounded text-[10px] overflow-x-auto">
                              {p.stackTrace}
                            </pre>
                          )}
                        </div>
                      );
                    })()}

                    {ev.type === 'exception' && (() => {
                      const p = ev.payload as ExceptionEventPayload;
                      return (
                        <div>
                          <div className="font-mono text-[11px] text-red-700">
                            {p.message}
                          </div>
                          {isSelected && p.stackTrace && (
                            <pre className="mt-2 p-2 bg-red-950 text-red-100 rounded text-[10px] overflow-x-auto">
                              {p.stackTrace}
                            </pre>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })
            )}
          </div>

          {/* Expandable Network Details Drawer (Headers, Payload, Response) */}
          {selectedEvent && selectedEvent.type === 'network' && (
            <NetworkInspectorDrawer
              event={selectedEvent as SessionEvent<NetworkEventPayload>}
              onClose={() => setSelectedEventId(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
