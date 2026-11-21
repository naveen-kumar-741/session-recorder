import { db } from '../database/db';

let mediaRecorder: MediaRecorder | null = null;
let activeStream: MediaStream | null = null;
let currentSessionId: string | null = null;
let sessionStartTime = 0;
let chunkSequence = 0;
let totalBytes = 0;
let selectedMimeType = 'video/webm';

function pickSupportedMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

async function startCapture(params: {
  sessionId: string;
  streamId: string;
  captureAudio: boolean;
  startedAt: number;
  timesliceMs: number;
}) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    await stopCapture();
  }

  currentSessionId = params.sessionId;
  sessionStartTime = params.startedAt;
  chunkSequence = 0;
  totalBytes = 0;

  const constraints: MediaStreamConstraints = {
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: params.streamId,
      },
    } as unknown as MediaTrackConstraints,
    audio: params.captureAudio
      ? ({
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: params.streamId,
          },
        } as unknown as MediaTrackConstraints)
      : false,
  };

  activeStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (params.captureAudio && activeStream.getAudioTracks().length > 0) {
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(activeStream);
    source.connect(audioCtx.destination);
  }

  selectedMimeType = pickSupportedMimeType();
  mediaRecorder = selectedMimeType
    ? new MediaRecorder(activeStream, { mimeType: selectedMimeType })
    : new MediaRecorder(activeStream);

  mediaRecorder.ondataavailable = async (event: BlobEvent) => {
    if (!event.data || event.data.size === 0 || !currentSessionId) return;
    const now = Date.now();
    const seq = chunkSequence++;
    const size = event.data.size;
    totalBytes += size;

    await db.videoChunks.put({
      id: `${currentSessionId}_chunk_${seq}`,
      sessionId: currentSessionId,
      sequence: seq,
      timestamp: now,
      relativeTimeMs: Math.max(0, now - sessionStartTime),
      blob: event.data,
      sizeBytes: size,
    });

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_CHUNK_SAVED',
      payload: {
        sessionId: currentSessionId,
        sequence: seq,
        sizeBytes: size,
        totalBytes,
        mimeType: mediaRecorder?.mimeType || selectedMimeType,
      },
    }).catch(() => {});
  };

  mediaRecorder.onerror = (event) => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_RECORDER_ERROR',
      payload: {
        sessionId: currentSessionId,
        error: String((event as ErrorEvent)?.message || 'MediaRecorder error'),
      },
    }).catch(() => {});
  };

  activeStream.getVideoTracks().forEach((track) => {
    track.onended = () => {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_STREAM_ENDED',
        payload: { sessionId: currentSessionId },
      }).catch(() => {});
    };
  });

  mediaRecorder.start(params.timesliceMs || 2000);
}

function pauseCapture() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
  }
}

function resumeCapture() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
  }
}

async function stopCapture(): Promise<{ totalBytes: number; chunkCount: number; mimeType: string }> {
  const result = {
    totalBytes,
    chunkCount: chunkSequence,
    mimeType: mediaRecorder?.mimeType || selectedMimeType,
  };

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      if (!mediaRecorder) return resolve();
      mediaRecorder.onstop = () => resolve();
      mediaRecorder.stop();
    });
  }

  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }

  result.totalBytes = totalBytes;
  result.chunkCount = chunkSequence;
  mediaRecorder = null;
  currentSessionId = null;
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'OFFSCREEN_START':
          await startCapture(message.payload);
          sendResponse({ ok: true });
          break;
        case 'OFFSCREEN_PAUSE':
          pauseCapture();
          sendResponse({ ok: true });
          break;
        case 'OFFSCREEN_RESUME':
          resumeCapture();
          sendResponse({ ok: true });
          break;
        case 'OFFSCREEN_STOP': {
          const stats = await stopCapture();
          sendResponse({ ok: true, stats });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown offscreen command' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err as Error).message });
    }
  })();

  return true;
});
