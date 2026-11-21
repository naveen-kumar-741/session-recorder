import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Circle, ExternalLink, Pause, Play, Square } from 'lucide-react';
import type { ActiveRecordingState } from '../types/session';
import '../index.css';

function PopupApp() {
  const [recState, setRecState] = useState<ActiveRecordingState | null>(null);
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);
  const [error, setError] = useState<string>('');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) setActiveTab(tab);
    });

    chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }).then((res) => {
      if (res?.state) setRecState(res.state);
    });

    const listener = (msg: any) => {
      if (msg?.type === 'RECORDING_STATE_UPDATED') {
        setRecState(msg.payload);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    if (!recState || (recState.status !== 'recording' && recState.status !== 'paused')) return;
    const id = setInterval(() => {
      if (recState.status === 'recording') {
        setElapsed(Date.now() - recState.startedAt - recState.accumulatedPauseMs);
      }
      chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }).then((res) => {
        if (res?.state) setRecState(res.state);
      }).catch(() => {});
    }, 500);
    return () => clearInterval(id);
  }, [recState?.status, recState?.startedAt, recState?.accumulatedPauseMs]);

  const sendCommand = async (type: string, payload?: Record<string, unknown>) => {
    setError('');
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res?.ok && res?.error) {
      setError(res.error);
    }
  };

  const openDashboard = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  };

  const isRecording = recState?.status === 'recording';
  const isPaused = recState?.status === 'paused';
  const isActive = isRecording || isPaused;

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const mins = String(Math.floor(s / 60)).padStart(2, '0');
    const secs = String(s % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  };

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
        <div className="flex items-center gap-2 font-semibold text-sm text-slate-900">
          <span className={`h-2.5 w-2.5 rounded-full ${isRecording ? 'bg-red-600 animate-pulse' : 'bg-slate-400'}`} />
          Session Recorder
        </div>
        <button
          onClick={openDashboard}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 cursor-pointer"
        >
          Dashboard <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded-md p-2.5 text-xs">
        <div className="text-slate-500 mb-0.5">{isActive ? 'Recording Tab' : 'Selected Tab'}</div>
        <div className="font-medium text-slate-900 truncate">
          {isActive ? recState?.tabTitle : activeTab?.title || 'No active tab'}
        </div>
        <div className="text-slate-500 truncate text-[11px]">
          {isActive ? recState?.tabUrl : activeTab?.url || ''}
        </div>
      </div>

      {isActive && recState && (
        <div className="grid grid-cols-4 gap-1.5 text-center bg-slate-900 text-white rounded-md p-2 text-xs">
          <div>
            <div className="text-[10px] text-slate-400">TIME</div>
            <div className="font-mono font-semibold">{formatDuration(elapsed)}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-400">NET</div>
            <div className="font-mono font-semibold">{recState.counters.network}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-400">LOG</div>
            <div className="font-mono font-semibold text-blue-300">{recState.counters.console}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-400">ERR</div>
            <div className="font-mono font-semibold text-red-400">{recState.counters.errors}</div>
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        {!isActive ? (
          <button
            onClick={() => activeTab?.id && sendCommand('START_RECORDING', { tabId: activeTab.id })}
            disabled={!activeTab?.id}
            className="w-full inline-flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-medium py-2 px-3 rounded-md cursor-pointer"
          >
            <Circle className="w-3.5 h-3.5 fill-current" /> Start Recording
          </button>
        ) : (
          <>
            <button
              onClick={() => sendCommand(isPaused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING')}
              className="flex-1 inline-flex items-center justify-center gap-1 bg-slate-200 hover:bg-slate-300 text-slate-900 text-xs font-medium py-2 px-2.5 rounded-md cursor-pointer"
            >
              {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={() => sendCommand('STOP_RECORDING')}
              className="flex-1 inline-flex items-center justify-center gap-1 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium py-2 px-2.5 rounded-md cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 fill-current" /> Stop
            </button>
          </>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>
);
