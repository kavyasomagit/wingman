/**
 * Feasibility test: can Expo Go stream raw microphone PCM (expo-audio AudioStream)?
 * Guarded so a missing native class can't crash the app.
 */
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import AudioModule from 'expo-audio/build/AudioModule';
import { Platform } from 'react-native';

export interface MicStreamResult {
  ok: boolean;
  platform: string;
  hasClass: boolean;
  buffers: number;
  bytes: number;
  sampleRate: number | null;
  channels: number | null;
  firstBufferMs: number | null;
  peak: number; // 0..1, proves it's real sound, not silence
  error: string | null;
}

export async function runMicStreamTest(seconds = 4): Promise<MicStreamResult> {
  const r: MicStreamResult = {
    ok: false,
    platform: `${Platform.OS} ${Platform.Version}`,
    hasClass: false,
    buffers: 0,
    bytes: 0,
    sampleRate: null,
    channels: null,
    firstBufferMs: null,
    peak: 0,
    error: null,
  };
  let stream: any = null;
  let sub: { remove(): void } | null = null;
  try {
    const Ctor = (AudioModule as any)?.AudioStream;
    r.hasClass = typeof Ctor === 'function';
    if (!r.hasClass) throw new Error('AudioStream native class not in this Expo Go build');
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) throw new Error('microphone permission denied');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    stream = new Ctor({ sampleRate: 16000, channels: 1, encoding: 'int16' });
    const t0 = Date.now();
    sub = stream.addListener('audioStreamBuffer', (b: { data: ArrayBuffer; sampleRate: number; channels: number }) => {
      if (r.firstBufferMs == null) r.firstBufferMs = Date.now() - t0;
      r.buffers++;
      r.bytes += b.data.byteLength;
      r.sampleRate = b.sampleRate;
      r.channels = b.channels;
      const s = new Int16Array(b.data);
      for (let i = 0; i < s.length; i += 4) {
        const v = Math.abs(s[i]) / 32768;
        if (v > r.peak) r.peak = v;
      }
    });
    await stream.start();
    await new Promise((res) => setTimeout(res, seconds * 1000));
    r.ok = r.buffers > 0 && r.bytes > 0;
  } catch (e) {
    r.error = String((e as Error)?.message ?? e).slice(0, 300);
  } finally {
    try {
      sub?.remove();
      stream?.stop();
      stream?.release?.();
    } catch {}
    try {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch {}
  }
  r.peak = Math.round(r.peak * 1000) / 1000;
  return r;
}
