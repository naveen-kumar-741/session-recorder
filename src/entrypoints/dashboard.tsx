import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  Download,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  Play,
  Radio,
  Settings as SettingsIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  db,
  deleteSessionCompletely,
  getSettings,
  getStorageStats,
  updateSettings,
} from '../database/db';
import { exportSessionAsZip, importSessionFromZip } from '../services/archive-service';
import { ReplayViewer } from '../features/replay/ReplayViewer';
import type { ActiveRecordingState, ExtensionSettings, Session } from '../types/session';
import '../index.css';

type Route = 'dashboard' | 'recorder' | 'sessions' | 'replay' | 'import' | 'settings';

function DashboardApp() {
  const [route, setRoute] = useState<Route>('dashboard');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [recState, setRecState] = useState<ActiveRecordingState | null>(null);
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [storageStats, setStorageStats] = useState<{
    totalSessions: number;
    totalDurationMs: number;
    totalVideoBytes: number;
  }>({ totalSessions: 0, totalDurationMs: 0, totalVideoBytes: 0 });
  const [importProgress, setImportProgress] = useState<{ pct: number; stage: string } | null>(null);
  const [bannerError, setBannerError] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');

  const refreshData = async () => {
    const all = await db.sessions.orderBy('startedAt').reverse().toArray();
    setSessions(all);
    setStorageStats(await getStorageStats());
    setSettings(await getSettings());
  };

  useEffect(() => {
    void refreshData();
    chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }).then((res) => {
      if (res?.state) setRecState(res.state);
    });
    chrome.tabs.query({ windowType: 'normal' }).then((list) => {
      const recordable = list.filter(
        (t) => t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
      );
      setTabs(recordable);
      if (recordable[0]?.id) setSelectedTabId(recordable[0].id);
    });

    const listener = (msg: any) => {
      if (msg?.type === 'RECORDING_STATE_UPDATED') {
        setRecState(msg.payload);
        if (msg.payload.status === 'idle') {
          void refreshData();
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  const handleStartRecording = async () => {
    if (!selectedTabId) return;
    setBannerError('');
    const res = await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: selectedTabId });
    if (!res?.ok) setBannerError(res?.error || 'Failed to start recording');
  };

  const handleExport = async (session: Session) => {
    const blob = await exportSessionAsZip(session.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.name.replace(/[^a-z0-9-_]+/gi, '_')}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async (id: string) => {
    await deleteSessionCompletely(id);
    await refreshData();
  };

  const handleImportFile = async (file: File) => {
    setBannerError('');
    try {
      const imported = await importSessionFromZip(file, (pct, stage) => {
        setImportProgress({ pct, stage });
      });
      await refreshData();
      setSelectedSessionId(imported.id);
      setRoute('replay');
    } catch (err) {
      setBannerError((err as Error).message);
    } finally {
      setImportProgress(null);
    }
  };

  const filteredSessions = sessions.filter(
    (s) =>
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.tab.initialUrl.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      <aside className="w-60 bg-white border-r border-slate-200 p-4 flex flex-col gap-1">
        <div className="px-2 py-3 mb-2 font-bold text-base tracking-tight text-slate-900 flex items-center gap-2">
          <Radio className="w-5 h-5 text-red-600" />
          Session Recorder
        </div>

        {(
          [
            { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
            { id: 'recorder', label: 'Recorder', icon: Radio },
            { id: 'sessions', label: 'Sessions', icon: FolderOpen },
            { id: 'import', label: 'Import ZIP', icon: Upload },
            { id: 'settings', label: 'Settings', icon: SettingsIcon },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setRoute(item.id)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium cursor-pointer ${
                route === item.id
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </button>
          );
        })}
      </aside>

      <main className="flex-1 p-6 max-w-6xl mx-auto w-full">
        {bannerError && (
          <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
            {bannerError}
          </div>
        )}

        {route === 'replay' && selectedSessionId && (
          <ReplayViewer sessionId={selectedSessionId} onBack={() => setRoute('sessions')} />
        )}

        {route === 'dashboard' && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold text-slate-900">Overview</h1>
              <div className="flex gap-2">
                <button
                  onClick={() => setRoute('import')}
                  className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer"
                >
                  Import ZIP
                </button>
                <button
                  onClick={() => setRoute('recorder')}
                  className="px-3 py-2 text-xs font-medium bg-red-600 text-white rounded-md hover:bg-red-700 cursor-pointer"
                >
                  New Recording
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-xs text-slate-500">Total Sessions</div>
                <div className="text-2xl font-bold mt-1">{storageStats.totalSessions}</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-xs text-slate-500">Total Recorded Time</div>
                <div className="text-2xl font-bold mt-1">{formatDuration(storageStats.totalDurationMs)}</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <HardDrive className="w-3.5 h-3.5" /> Local Storage Used
                </div>
                <div className="text-2xl font-bold mt-1">{formatBytes(storageStats.totalVideoBytes)}</div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <h2 className="text-sm font-semibold mb-3">Recent Sessions</h2>
              {sessions.length === 0 ? (
                <p className="text-xs text-slate-500">No sessions recorded yet.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {sessions.slice(0, 5).map((s) => (
                    <div key={s.id} className="py-2.5 flex items-center justify-between text-xs">
                      <div>
                        <div className="font-medium text-slate-900">{s.name}</div>
                        <div className="text-slate-500">{s.tab.initialUrl}</div>
                      </div>
                      <button
                        onClick={() => {
                          setSelectedSessionId(s.id);
                          setRoute('replay');
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-900 text-white rounded cursor-pointer"
                      >
                        <Play className="w-3 h-3" /> Replay
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {route === 'recorder' && (
          <div className="bg-white border border-slate-200 rounded-lg p-6 max-w-2xl flex flex-col gap-4">
            <h1 className="text-lg font-bold">Tab Session Recorder</h1>
            <p className="text-xs text-slate-600">
              Attaches Chrome DevTools Protocol to capture network and console diagnostics alongside tab video.
              Chrome will display a debugging banner on the target tab while recording.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Target Browser Tab</label>
              <select
                value={selectedTabId ?? ''}
                onChange={(e) => setSelectedTabId(Number(e.target.value))}
                disabled={recState?.status === 'recording' || recState?.status === 'paused'}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs"
              >
                {tabs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} — {t.url}
                  </option>
                ))}
              </select>
            </div>

            {recState && recState.status !== 'idle' && (
              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-xs grid grid-cols-2 gap-2">
                <div>Status: <strong className="uppercase">{recState.status}</strong></div>
                <div>Video Collector: <strong>{recState.collectors.video}</strong></div>
                <div>Network Events: <strong>{recState.counters.network}</strong></div>
                <div>Console / Errors: <strong>{recState.counters.console} / {recState.counters.errors}</strong></div>
              </div>
            )}

            <div className="flex gap-2">
              {recState?.status === 'idle' || !recState ? (
                <button
                  onClick={handleStartRecording}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-md cursor-pointer"
                >
                  Start Recording
                </button>
              ) : (
                <>
                  <button
                    onClick={() =>
                      chrome.runtime.sendMessage({
                        type: recState.status === 'paused' ? 'RESUME_RECORDING' : 'PAUSE_RECORDING',
                      })
                    }
                    className="px-4 py-2 bg-slate-200 text-slate-900 text-xs font-medium rounded-md cursor-pointer"
                  >
                    {recState.status === 'paused' ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    onClick={() => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' })}
                    className="px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-md cursor-pointer"
                  >
                    Stop & Save
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {route === 'sessions' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold">Saved Sessions</h1>
              <input
                type="text"
                placeholder="Search sessions..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="border border-slate-300 bg-white rounded-md px-3 py-1.5 text-xs w-64"
              />
            </div>

            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="p-3">Name</th>
                    <th className="p-3">Duration</th>
                    <th className="p-3">Size</th>
                    <th className="p-3">Diagnostics</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredSessions.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="p-3">
                        <div className="font-medium text-slate-900">{s.name}</div>
                        <div className="text-slate-500 truncate max-w-xs">{s.tab.initialUrl}</div>
                      </td>
                      <td className="p-3">{formatDuration(s.durationMs)}</td>
                      <td className="p-3">{formatBytes(s.video.totalBytes)}</td>
                      <td className="p-3">
                        {s.statistics.networkRequests} req · {s.statistics.errors} err
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex gap-1.5">
                          <button
                            onClick={() => {
                              setSelectedSessionId(s.id);
                              setRoute('replay');
                            }}
                            className="p-1.5 bg-slate-900 text-white rounded hover:bg-slate-800 cursor-pointer"
                            title="Replay"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleExport(s)}
                            className="p-1.5 bg-slate-100 text-slate-700 rounded hover:bg-slate-200 cursor-pointer"
                            title="Export ZIP"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(s.id)}
                            className="p-1.5 bg-red-50 text-red-600 rounded hover:bg-red-100 cursor-pointer"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {route === 'import' && (
          <div className="bg-white border border-slate-200 rounded-lg p-6 max-w-xl flex flex-col gap-4">
            <h1 className="text-lg font-bold">Import Session ZIP</h1>
            <label className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500">
              <Upload className="w-6 h-6 mx-auto text-slate-400 mb-2" />
              <div className="text-xs font-medium text-slate-700">Select a `.zip` session archive</div>
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportFile(file);
                }}
              />
            </label>
            {importProgress && (
              <div className="text-xs text-blue-700">
                {importProgress.stage} ({importProgress.pct}%)
              </div>
            )}
          </div>
        )}

        {route === 'settings' && settings && (
          <div className="bg-white border border-slate-200 rounded-lg p-6 max-w-xl flex flex-col gap-4 text-xs">
            <h1 className="text-lg font-bold">Privacy & Recording Settings</h1>

            <label className="flex items-center justify-between">
              <span>Capture Tab Audio</span>
              <input
                type="checkbox"
                checked={settings.captureAudio}
                onChange={async (e) => {
                  setSettings(await updateSettings({ captureAudio: e.target.checked }));
                }}
              />
            </label>

            <label className="flex items-center justify-between">
              <span>Capture Request Payloads & Response Bodies</span>
              <input
                type="checkbox"
                checked={settings.captureNetworkBodies}
                onChange={async (e) => {
                  setSettings(await updateSettings({ captureNetworkBodies: e.target.checked }));
                }}
              />
            </label>

            <label className="flex items-center justify-between">
              <span>Redact Sensitive Headers & JSON Fields (Passwords, Tokens, API Keys)</span>
              <input
                type="checkbox"
                checked={settings.redactHeaders}
                onChange={async (e) => {
                  setSettings(await updateSettings({ redactHeaders: e.target.checked }));
                }}
              />
            </label>

            <label className="flex items-center justify-between">
              <span>Redact Sensitive URL Query Parameters</span>
              <input
                type="checkbox"
                checked={settings.redactQueryParams}
                onChange={async (e) => {
                  setSettings(await updateSettings({ redactQueryParams: e.target.checked }));
                }}
              />
            </label>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block font-medium mb-1">Max Body Size per Request (KB)</label>
                <input
                  type="number"
                  min={16}
                  max={2048}
                  value={settings.maxBodySizeKb}
                  onChange={async (e) => {
                    setSettings(await updateSettings({ maxBodySizeKb: Number(e.target.value) }));
                  }}
                  className="border border-slate-300 rounded px-2.5 py-1.5 w-full"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Max Session Size Limit (MB)</label>
                <input
                  type="number"
                  min={50}
                  max={4096}
                  value={settings.maxSessionSizeMb}
                  onChange={async (e) => {
                    setSettings(await updateSettings({ maxSessionSizeMb: Number(e.target.value) }));
                  }}
                  className="border border-slate-300 rounded px-2.5 py-1.5 w-full"
                />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DashboardApp />
  </React.StrictMode>
);
