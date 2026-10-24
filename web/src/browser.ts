/** Browser adapters: camera frames, 16 kHz mic stream, push-to-talk recorder, speech, haptics, wake lock. */
import type { Speaker } from './core/speechQueue';
import type { FrameSource, Haptics, Recorder } from './agents';

// ---------- camera + mic (one permission prompt) ----------
export async function openMedia(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});
  return stream;
}

export function cameraFrames(video: HTMLVideoElement): FrameSource {
  const canvas = document.createElement('canvas');
  return {
    async capture() {
      if (!video.videoWidth) return null;
      const w = 640;
      const h = Math.round((video.videoHeight / video.videoWidth) * w);
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(video, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.6).split(',')[1] ?? null;
    },
  };
}

/**
 * Quota saver for the perception loop: skip a frame when the scene has barely changed since the
 * last frame that was sent, but always send at least one every `maxSkipMs`.
 * Compares 32x24 grayscale thumbnails (mean absolute difference, 0-255).
 */
export function changedFramesOnly(
  video: HTMLVideoElement,
  inner: FrameSource,
  { threshold = 7, maxSkipMs = 20_000 } = {},
): FrameSource & { skipped: number } {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 24;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  let last: Uint8ClampedArray | null = null;
  let lastSentAt = 0;
  const self = {
    skipped: 0,
    async capture() {
      if (!video.videoWidth) return null;
      ctx.drawImage(video, 0, 0, 32, 24);
      const px = ctx.getImageData(0, 0, 32, 24).data;
      const gray = new Uint8ClampedArray(32 * 24);
      for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
      if (last && Date.now() - lastSentAt < maxSkipMs) {
        let d = 0;
        for (let i = 0; i < gray.length; i++) d += Math.abs(gray[i] - last[i]);
        if (d / gray.length < threshold) {
          self.skipped++;
          return null;
        }
      }
      last = gray;
      lastSentAt = Date.now();
      return inner.capture();
    },
  };
  return self;
}

// ---------- continuous 16 kHz int16 mic stream (100 ms chunks) ----------
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
}
registerProcessor('iris-tap', Tap);`;

export async function startMicStream(stream: MediaStream, onChunk: (pcm: Int16Array) => void): Promise<() => void> {
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  let ctx: AudioContext;
  try {
    ctx = new Ctx({ sampleRate: 16000 });
  } catch {
    ctx = new Ctx();
  }
  await ctx.resume();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'iris-tap');
  const ratio = ctx.sampleRate / 16000;
  const CHUNK = 1600; // 100 ms at 16 kHz
  let buf = new Int16Array(CHUNK);
  let n = 0;
  let pos = 0; // fractional read position for resampling
  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    const input = ev.data;
    for (; pos < input.length; pos += ratio) {
      const v = Math.max(-1, Math.min(1, input[Math.floor(pos)]));
      buf[n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (n === CHUNK) {
        onChunk(buf);
        buf = new Int16Array(CHUNK);
        n = 0;
      }
    }
    pos -= input.length;
  };
  src.connect(node);
  // Keep the graph pulling without playing the mic back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  return () => {
    try {
      src.disconnect();
      node.disconnect();
      void ctx.close();
    } catch {}
  };
}

// ---------- push-to-talk recorder (MediaRecorder) ----------
export function mediaRecorder(stream: MediaStream): Recorder {
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let mime = '';
  return {
    async start() {
      const audioOnly = new MediaStream(stream.getAudioTracks());
      mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      rec = new MediaRecorder(audioOnly, mime ? { mimeType: mime } : undefined);
      chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.start();
    },
    async stop() {
      const r = rec;
      if (!r) return null;
      await new Promise<void>((res) => {
        r.onstop = () => res();
        r.stop();
      });
      rec = null;
      const blob = new Blob(chunks, { type: r.mimeType || mime });
      if (blob.size < 2000) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { audio: btoa(s), mime: (r.mimeType || mime || 'audio/webm').split(';')[0] };
    },
  };
}

// ---------- speech (Web Speech API) ----------
export const browserSpeaker: Speaker = {
  speak(text, onDone) {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(guard);
        onDone();
      }
    };
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.lang = 'en-US';
    u.onend = finish;
    u.onerror = finish;
    // Some browsers occasionally never fire onend; don't let the queue stall.
    const guard = setTimeout(finish, Math.max(4000, text.length * 110));
    window.speechSynthesis.speak(u);
  },
  stop() {
    window.speechSynthesis.cancel();
  },
};

export const browserHaptics: Haptics = {
  alert(urgency) {
    navigator.vibrate?.(urgency === 'high' ? [250, 100, 250, 100, 250] : [200, 100, 200]);
  },
  tick() {
    navigator.vibrate?.(30);
  },
};

// ---------- keep the screen awake while worn ----------
export function keepAwake(): () => void {
  let lock: any = null;
  const request = async () => {
    try {
      lock = await (navigator as any).wakeLock?.request('screen');
    } catch {}
  };
  const onVis = () => document.visibilityState === 'visible' && void request();
  void request();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    void lock?.release?.();
  };
}
