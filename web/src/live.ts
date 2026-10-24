/**
 * Hands-free Communicator, browser edition: connects straight to the Gemini Live API with a
 * single-use ephemeral token from /api/live-token (the real key stays on the server).
 * Answer text (output transcription) is spoken sentence by sentence through the shared
 * SpeechQueue, so Guardian alerts still interrupt it. Gemini's own audio is ignored.
 */
import type { SpeechQueue } from './core/speechQueue';
import { sanitizeSpeech } from './core/safety';
import { api } from './api';

export type LiveState = 'off' | 'connecting' | 'ready' | 'reconnecting' | 'error';

const WAKE = /\b(iris|irish|irus|iras|irez|ayris|eyris|eye ris|i ris|hey iris)\b/i;
export function addressedToIris(heard: string): boolean {
  return WAKE.test(heard);
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Memory is re-sent by reconnecting (new token); at most this often, and only when idle. */
const MEMORY_REFRESH_MS = 90_000;

export class LiveClient {
  state: LiveState = 'off';
  requireWake = true;
  heard = '';
  lastHeard = '';
  lastAnswer = '';
  lastIgnored = '';
  lastError = '';
  private ws: WebSocket | null = null;
  private want = false;
  private retry = 0;
  private sessionAt = 0;
  private lastHeardAt = 0;
  private inTurn = false;
  private memoryAtConnect = '';
  private turnText = '';
  private spokenUpTo = 0;
  private decided: boolean | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private queue: SpeechQueue,
    private getMemory: () => string,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((fn) => fn());
  }
  private setState(s: LiveState) {
    this.state = s;
    this.emit();
  }

  connect(): void {
    this.want = true;
    if (!this.ws) void this.open();
  }

  disconnect(): void {
    this.want = false;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    this.setState('off');
  }

  private async open(): Promise<void> {
    this.setState(this.retry ? 'reconnecting' : 'connecting');
    let tok;
    try {
      this.memoryAtConnect = this.getMemory();
      tok = await api.liveToken(this.memoryAtConnect);
    } catch (e) {
      this.lastError = String((e as Error).message ?? e);
      return this.scheduleRetry();
    }
    if (!this.want) return;
    const ws = new WebSocket(tok.url);
    this.ws = ws;
    this.sessionAt = Date.now();
    ws.onopen = () => ws.send(JSON.stringify({ setup: tok.setup }));
    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : await (ev.data as Blob).text();
      try {
        this.onGemini(JSON.parse(raw));
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code !== 1000 && e.reason) this.lastError = `closed ${e.code}: ${e.reason}`.slice(0, 200);
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (!this.want) return this.setState('off');
    this.retry++;
    this.setState(this.retry > 6 ? 'error' : 'reconnecting');
    setTimeout(() => this.want && !this.ws && void this.open(), Math.min(8000, 1000 * this.retry));
  }

  /** Reconnect with fresh memory, but never mid-conversation. */
  private maybeRefresh(): void {
    if (this.inTurn || Date.now() - this.lastHeardAt < 8000) return;
    if (Date.now() - this.sessionAt < MEMORY_REFRESH_MS) return;
    if (this.getMemory() === this.memoryAtConnect) return;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    void this.open();
  }

  get isReady(): boolean {
    return this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN;
  }

  sendAudio(pcm16: Int16Array): void {
    if (!this.isReady) return;
    const data = toBase64(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
    this.ws!.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } }));
  }

  sendFrame(jpegBase64: string): void {
    if (!this.isReady) return;
    this.ws!.send(JSON.stringify({ realtimeInput: { video: { data: jpegBase64, mimeType: 'image/jpeg' } } }));
    this.maybeRefresh();
  }

  private onGemini(m: any): void {
    if (m.setupComplete) {
      this.retry = 0;
      this.lastError = '';
      return this.setState('ready');
    }
    if (m.goAway) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws?.close();
      } catch {}
      void this.open();
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.handle({ type: 'heard', text: sc.inputTranscription.text });
    if (sc.outputTranscription?.text) this.handle({ type: 'text', text: sc.outputTranscription.text });
    if (sc.interrupted) this.handle({ type: 'interrupted' });
    if (sc.turnComplete) this.handle({ type: 'turn_complete' });
  }

  /** Same turn logic as the phone app (unit tested). */
  private handle(m: { type: string; text?: string }): void {
    switch (m.type) {
      case 'heard':
        this.inTurn = true;
        this.lastHeardAt = Date.now();
        this.heard += m.text ?? '';
        this.emit();
        break;
      case 'text':
        this.turnText += m.text ?? '';
        this.decide(false);
        this.speakSentences(false);
        break;
      case 'interrupted':
        this.turnText = this.turnText.slice(0, this.spokenUpTo);
        break;
      case 'turn_complete':
        this.decide(true);
        this.speakSentences(true);
        this.endTurn();
        break;
    }
  }

  private decide(final: boolean): void {
    if (this.decided !== null) return;
    const h = this.heard.trim();
    if (!h && !final) return;
    this.decided = !this.requireWake || addressedToIris(h);
    if (this.decided) this.queue.cancelNormal();
  }

  private speakSentences(flush: boolean): void {
    if (!this.decided) return;
    const pending = this.turnText.slice(this.spokenUpTo);
    let cut = -1;
    const re = /[.!?](\s|$)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(pending))) cut = match.index + 1;
    if (flush) cut = pending.length;
    if (cut <= 0) return;
    const sentence = pending.slice(0, cut).trim();
    this.spokenUpTo += cut;
    if (sentence) this.queue.say(sanitizeSpeech(sentence));
  }

  private endTurn(): void {
    const heard = this.heard.trim();
    if (heard) {
      if (this.decided) {
        this.lastHeard = heard;
        this.lastAnswer = sanitizeSpeech(this.turnText.trim());
      } else this.lastIgnored = heard;
    }
    this.inTurn = false;
    this.heard = '';
    this.turnText = '';
    this.spokenUpTo = 0;
    this.decided = null;
    this.emit();
  }
}
