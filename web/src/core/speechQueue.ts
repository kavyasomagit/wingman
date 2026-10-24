/**
 * Single priority speech queue (R7).
 * - Alerts (Guardian) interrupt normal speech immediately.
 * - Interrupted normal speech resumes from the interrupted sentence.
 * - Alerts never interrupt other alerts; they queue in order.
 */
export type Priority = 'alert' | 'normal';

export interface Speaker {
  /** Speak text; call onDone exactly once when finished (or failed). */
  speak(text: string, onDone: () => void): void;
  /** Stop speaking immediately. May or may not invoke the pending onDone. */
  stop(): void;
}

interface Item {
  priority: Priority;
  sentences: string[];
  index: number;
}

export interface QueueState {
  speaking: boolean;
  priority: Priority | null;
  text: string | null;
}

export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g);
  return (parts ?? []).map((s) => s.trim()).filter(Boolean);
}

export class SpeechQueue {
  private alerts: Item[] = [];
  private normals: Item[] = [];
  private current: Item | null = null;
  private token = 0;
  private listeners = new Set<(s: QueueState) => void>();

  constructor(private speaker: Speaker) {}

  /** Urgent: interrupts any normal speech right now. */
  alert(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (this.alerts.some((a) => a.sentences.join(' ') === t)) return;
    if (this.current?.priority === 'alert' && this.current.sentences.join(' ') === t) return;
    this.alerts.push({ priority: 'alert', sentences: [t], index: 0 });
    if (this.current && this.current.priority === 'normal') {
      const interrupted = this.current;
      this.current = null;
      this.token++; // invalidate the interrupted utterance's onDone
      this.speaker.stop();
      this.normals.unshift(interrupted); // resumes at interrupted.index
    }
    this.next();
  }

  /** Normal priority (Communicator answers, status lines). */
  say(text: string): void {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return;
    this.normals.push({ priority: 'normal', sentences, index: 0 });
    this.next();
  }

  /** Drop all normal speech (e.g. user starts asking a new question). Alerts are kept. */
  cancelNormal(): void {
    this.normals = [];
    if (this.current?.priority === 'normal') {
      this.current = null;
      this.token++;
      this.speaker.stop();
      this.next();
    }
    this.emit();
  }

  get state(): QueueState {
    const c = this.current;
    return {
      speaking: !!c,
      priority: c?.priority ?? null,
      text: c ? c.sentences[c.index] ?? null : null,
    };
  }

  subscribe(fn: (s: QueueState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private next(): void {
    if (!this.current) {
      this.current = this.alerts.shift() ?? this.normals.shift() ?? null;
      if (this.current) this.speakCurrent();
    }
    this.emit();
  }

  private speakCurrent(): void {
    const item = this.current!;
    const myToken = ++this.token;
    this.speaker.speak(item.sentences[item.index], () => {
      if (myToken !== this.token || this.current !== item) return; // stale callback
      item.index++;
      if (item.index >= item.sentences.length) {
        this.current = null;
        this.next();
      } else if (item.priority === 'normal' && this.alerts.length > 0) {
        // An alert queued between sentences: yield to it, then resume.
        this.current = null;
        this.normals.unshift(item);
        this.next();
      } else {
        this.speakCurrent();
        this.emit();
      }
    });
  }

  private emit(): void {
    const s = this.state;
    this.listeners.forEach((fn) => fn(s));
  }
}
