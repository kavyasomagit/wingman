/**
 * Hands-free Communicator over the server's /live WebSocket relay (Gemini Live API).
 * Mic PCM goes up as binary frames; answer text comes back and is spoken sentence by
 * sentence through the shared SpeechQueue, so Guardian alerts still interrupt it.
 */
import type { SpeechQueue } from './core/speechQueue';
import { sanitizeSpeech } from './core/safety';

export type LiveState = 'off' | 'connecting' | 'ready' | 'reconnecting';

const WAKE = /\b(iris|irish|irus|iras|irez|ayris|eyris|eye ris|i ris|hey iris)\b/i;

export function addressedToIris(heard: string): boolean {
  return WAKE.test(heard);
}

export class LiveClient {
  state: LiveState = 'off';
  requireWake = true;
  heard = '';
  lastHeard = '';
  lastAnswer = '';
  lastIgnored = '';
  private ws: WebSocket | null = null;
  private want = false;
  private retry = 0;
  private turnText = '';
  private spokenUpTo = 0;
  private decided: boolean | null = null;
  private lastMemorySent = '';
  private listeners = new Set<() => void>();

  constructor(
    private queue: SpeechQueue,
    private getUrl: () => string,
    private getMemory: () => string,
    private token = '',
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
    if (!this.ws) this.open();
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

  private open(): void {
    const url =
      this.getUrl().replace(/^http/, 'ws') + '/live' + (this.token ? `?token=${encodeURIComponent(this.token)}` : '');
    this.setState(this.retry ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.lastMemorySent = this.getMemory();
      ws.send(JSON.stringify({ type: 'start', memory: this.lastMemorySent }));
    };
    ws.onmessage = (ev) => {
      try {
        this.handle(JSON.parse(String(ev.data)));
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.want) return this.setState('off');
      this.retry++;
      this.setState('reconnecting');
      setTimeout(() => this.want && !this.ws && this.open(), Math.min(5000, 1000 * this.retry));
    };
  }

  get isReady(): boolean {
    return this.state === 'ready' && this.ws?.readyState === 1;
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.isReady) this.ws!.send(pcm);
  }

  sendFrame(jpegBase64: string): void {
    if (this.isReady) this.ws!.send(JSON.stringify({ type: 'frame', data: jpegBase64 }));
  }

  sendMemory(): void {
    if (!this.isReady) return;
    const m = this.getMemory();
    if (m === this.lastMemorySent) return;
    this.lastMemorySent = m;
    this.ws!.send(JSON.stringify({ type: 'memory', memory: m }));
  }

  private handle(m: { type: string; text?: string; state?: string }): void {
    switch (m.type) {
      case 'ready':
        this.retry = 0;
        this.setState('ready');
        break;
      case 'status':
        this.setState('reconnecting');
        break;
      case 'heard':
        this.heard += m.text ?? '';
        this.emit();
        break;
      case 'text':
        this.turnText += m.text ?? '';
        this.decide(false);
        this.speakSentences(false);
        break;
      case 'interrupted':
        // The user started talking again: drop the rest of this answer.
        this.turnText = this.turnText.slice(0, this.spokenUpTo);
        break;
      case 'turn_complete':
        this.decide(true);
        this.speakSentences(true);
        this.endTurn();
        break;
    }
  }

  /** Hands-free gate: only answer speech addressed to Iris (when requireWake is on). */
  private decide(final: boolean): void {
    if (this.decided !== null) return;
    const h = this.heard.trim();
    if (!h && !final) return; // wait until we know what was said
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
      } else {
        this.lastIgnored = heard;
      }
    }
    this.heard = '';
    this.turnText = '';
    this.spokenUpTo = 0;
    this.decided = null;
    this.emit();
  }
}
