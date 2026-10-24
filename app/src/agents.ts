/**
 * Iris agents. They run independently and only share the MemoryStore and SpeechQueue (design.md).
 */
import { api, type Perception as PerceptionResult } from './api';
import { AlertCooldown } from './core/cooldown';
import { MemoryStore } from './core/memory';
import { SpeechQueue } from './core/speechQueue';
import { sanitizeSpeech } from './core/safety';
import { resolveAnswer } from './core/answer';
import { timeAgo } from './core/format';

export interface FrameSource {
  /** Returns a downscaled base64 JPEG, or null if the camera isn't ready. */
  capture(): Promise<string | null>;
}
export interface Haptics {
  alert(urgency: 'high' | 'medium'): void;
  tick(): void;
}
export interface Recorder {
  start(): Promise<void>;
  /** Stops and returns base64 audio + mime type, or null if nothing recorded. */
  stop(): Promise<{ audio: string; mime: string } | null>;
}

export type Listener<T> = (v: T) => void;

// ---------- Perception: one camera loop feeding Guardian + Scene Logger ----------
export class PerceptionLoop {
  private running = false;
  private listeners = new Set<Listener<{ at: number; result: PerceptionResult; ms: number }>>();
  private frameListeners = new Set<Listener<string>>();
  lastError: string | null = null;

  /** Every captured frame (e.g. forwarded to the Live session so it sees the scene too). */
  onFrame(fn: Listener<string>): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  constructor(private frames: FrameSource, private intervalMs = 4000) {}

  onResult(fn: Listener<{ at: number; result: PerceptionResult; ms: number }>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }
  stop(): void {
    this.running = false;
  }
  get isRunning(): boolean {
    return this.running;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const t0 = Date.now();
      try {
        const frame = await this.frames.capture();
        if (frame && this.running) {
          this.frameListeners.forEach((fn) => fn(frame));
          const result = await api.perceive(frame); // never overlaps: awaited inside the loop (R1.1)
          this.lastError = null;
          const ms = Date.now() - t0;
          this.listeners.forEach((fn) => fn({ at: t0, result, ms }));
        }
      } catch (e) {
        this.lastError = String((e as Error)?.message ?? e);
        console.warn('[perception]', this.lastError);
      }
      const wait = Math.max(300, this.intervalMs - (Date.now() - t0));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ---------- Guardian: unprompted hazard warnings (R6) ----------
export class Guardian {
  enabled = true;
  staleDropped = 0;
  /** Hazards from frames older than this are dropped: the user has likely moved past them. */
  maxFrameAgeMs = 6000;
  constructor(
    private queue: SpeechQueue,
    private haptics: Haptics,
    private cooldown = new AlertCooldown(15_000),
  ) {}

  handle(result: PerceptionResult, frameAgeMs = 0): string[] {
    if (!this.enabled) return [];
    if (frameAgeMs > this.maxFrameAgeMs) {
      if ((result.hazards ?? []).length) this.staleDropped++;
      return [];
    }
    const spoken: string[] = [];
    const rank = { high: 2, medium: 1, low: 0 } as const;
    const hazards = [...(result.hazards ?? [])]
      .filter((h) => h && (h.urgency === 'high' || h.urgency === 'medium') && h.message)
      .sort((a, b) => rank[b.urgency] - rank[a.urgency])
      .slice(0, 2);
    for (const h of hazards) {
      if (!this.cooldown.shouldAlert(h.type || h.message, h.urgency)) continue;
      const msg = sanitizeSpeech(h.message);
      this.haptics.alert(h.urgency as 'high' | 'medium');
      this.queue.alert(msg);
      spoken.push(msg);
    }
    return spoken;
  }
}

// ---------- Scene Logger: timestamped events + last-seen index (R2) ----------
export class SceneLogger {
  lastScene = '';
  constructor(private store: MemoryStore) {}

  handle(result: PerceptionResult, at: number): void {
    for (const e of result.events ?? []) this.store.addEvent(e, at);
    for (const o of result.objects ?? []) {
      if (!o?.name) continue;
      this.store.recordSighting({
        label: o.name,
        location: o.location ?? '',
        place: o.place ?? '',
        near: o.near ?? [],
        held: !!o.held,
        at,
      });
    }
    if (result.scene && result.scene !== this.lastScene) {
      this.lastScene = result.scene;
    }
  }
}

function formatEvents(store: MemoryStore, since: number): string {
  const now = Date.now();
  return store
    .eventsSince(since)
    .map((e) => `- [${new Date(e.at).toLocaleTimeString()} / ${timeAgo(now - e.at)}] ${e.text}`)
    .join('\n');
}

// ---------- Short-Term Memory: rolling summary (R3) ----------
export class ShortTermMemory {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAt = 0;
  private busy = false;
  constructor(private store: MemoryStore, private intervalMs = 60_000) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    const events = formatEvents(this.store, this.lastAt);
    if (!events) return;
    this.busy = true;
    const now = Date.now();
    try {
      const { summary } = await api.summarize('short', events, this.store.shortTerm?.text);
      if (summary) this.store.setShortTerm(summary, now);
      this.lastAt = now;
    } catch (e) {
      console.warn('[stm]', e);
    } finally {
      this.busy = false;
    }
  }
}

// ---------- Long-Term Memory: diary + habits (R4) ----------
export class LongTermMemory {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(private store: MemoryStore, private intervalMs = 5 * 60_000) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    const since = this.store.diary[this.store.diary.length - 1]?.at ?? 0;
    const events = formatEvents(this.store, since);
    if (!events) return;
    this.busy = true;
    const now = Date.now();
    try {
      const habits = this.store
        .learnHabits()
        .map((h) => `${h.label} usually at ${h.place}`)
        .join('; ');
      const { summary } = await api.summarize('diary', events + (habits ? `\nKnown habits: ${habits}` : ''));
      if (summary) this.store.addDiary(summary, now);
    } catch (e) {
      console.warn('[ltm]', e);
    } finally {
      this.busy = false;
    }
  }
}

// ---------- Communicator: only speaks when asked (R5) ----------
export type CommState = 'idle' | 'listening' | 'thinking';

export class Communicator {
  state: CommState = 'idle';
  lastTranscript = '';
  lastAnswer = '';
  private listeners = new Set<Listener<CommState>>();

  constructor(
    private store: MemoryStore,
    private queue: SpeechQueue,
    private frames: FrameSource,
    private recorder: Recorder,
    private haptics: Haptics,
  ) {}

  onState(fn: Listener<CommState>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(s: CommState) {
    this.state = s;
    this.listeners.forEach((fn) => fn(s));
  }

  async startListening(): Promise<void> {
    if (this.state !== 'idle') return;
    this.queue.cancelNormal(); // barge-in: stop any ongoing answer
    this.set('listening');
    this.haptics.tick();
    try {
      await this.recorder.start();
    } catch (e) {
      console.warn('[comm] record start', e);
      this.set('idle');
      this.queue.say("I couldn't start the microphone.");
    }
  }

  async stopAndAnswer(): Promise<void> {
    if (this.state !== 'listening') return;
    this.set('thinking');
    this.haptics.tick();
    try {
      const framePromise = this.frames.capture().catch(() => null);
      const rec = await this.recorder.stop();
      if (!rec) {
        this.set('idle');
        this.queue.say("I didn't hear a question.");
        return;
      }
      const image = await framePromise;
      const res = await api.ask({ audio: rec.audio, audioMime: rec.mime, image, memory: this.store.contextForPrompt() });
      this.lastTranscript = res.transcript;
      this.lastAnswer = resolveAnswer(res, this.store);
      this.queue.say(this.lastAnswer);
    } catch (e) {
      console.warn('[comm]', e);
      this.queue.say("Sorry, I couldn't reach Iris's brain. Please try again.");
    } finally {
      this.set('idle');
    }
  }

  /** Typed question path (debug / backup for noisy demo rooms). */
  async askText(question: string): Promise<void> {
    if (this.state !== 'idle' || !question.trim()) return;
    this.queue.cancelNormal();
    this.set('thinking');
    try {
      const image = await this.frames.capture().catch(() => null);
      const res = await api.ask({ question, image, memory: this.store.contextForPrompt() });
      this.lastTranscript = res.transcript || question;
      this.lastAnswer = resolveAnswer(res, this.store);
      this.queue.say(this.lastAnswer);
    } catch (e) {
      console.warn('[comm]', e);
      this.queue.say("Sorry, I couldn't reach Iris's brain. Please try again.");
    } finally {
      this.set('idle');
    }
  }
}
