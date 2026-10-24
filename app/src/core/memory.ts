/**
 * Shared memory store. Agents never call each other; they read/write here (R2-R4).
 */
import { timeAgo } from './format';

export interface Sighting {
  key: string; // normalised name, e.g. "key"
  label: string; // spoken name, e.g. "keys"
  location: string; // "on the kitchen counter"
  place: string; // short canonical place for habits, e.g. "kitchen counter"
  near: string[];
  held: boolean;
  at: number;
}

export interface SceneEvent {
  at: number;
  text: string;
}

export interface Note {
  at: number;
  text: string;
}

export interface Habit {
  key: string;
  label: string;
  place: string;
  count: number;
  total: number;
}

export interface MemorySnapshot {
  v: 1;
  events: SceneEvent[];
  lastSeen: Record<string, Sighting>;
  history: Sighting[];
  shortTerm: Note | null;
  diary: Note[];
}

const MAX_EVENTS = 2000;
const MAX_HISTORY = 1000;
const STOP = new Set(['my', 'the', 'a', 'an', 'your', 'some', 'of', 'pair']);

function singular(w: string): string {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(s|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map(singular)
    .join(' ');
}

export class MemoryStore {
  events: SceneEvent[] = [];
  lastSeen: Record<string, Sighting> = {};
  history: Sighting[] = [];
  shortTerm: Note | null = null;
  diary: Note[] = [];
  private listeners = new Set<() => void>();

  addEvent(text: string, at = Date.now()): void {
    const t = text.trim();
    if (!t) return;
    const prev = this.events[this.events.length - 1];
    if (prev && prev.text === t && at - prev.at < 60_000) return; // skip exact repeats
    this.events.push({ at, text: t });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit();
  }

  recordSighting(input: Omit<Sighting, 'key' | 'place'> & { place?: string }): void {
    const key = normalizeName(input.label);
    if (!key) return;
    const s: Sighting = {
      ...input,
      key,
      place: (input.place || input.location || '').toLowerCase().trim(),
      near: input.near ?? [],
    };
    const prev = this.lastSeen[key];
    if (!prev || s.at >= prev.at) this.lastSeen[key] = s;
    if (!s.held && s.place) {
      this.history.push(s);
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    this.emit();
  }

  /** Most recent sighting matching the query (R5.3). */
  whereIs(query: string): Sighting | null {
    const q = normalizeName(query);
    if (!q) return null;
    if (this.lastSeen[q]) return this.lastSeen[q];
    const qWords = q.split(' ');
    const matches = Object.values(this.lastSeen).filter((s) => {
      if (s.key.includes(q) || q.includes(s.key)) return true;
      const words = s.key.split(' ');
      return qWords.some((w) => w.length > 2 && words.includes(w));
    });
    if (matches.length === 0) return null;
    return matches.reduce((a, b) => (b.at > a.at ? b : a));
  }

  /** Most frequent place per object, needs at least 2 sightings (R4.2). */
  learnHabits(): Habit[] {
    const byKey = new Map<string, { label: string; places: Map<string, number>; total: number }>();
    for (const s of this.history) {
      const e = byKey.get(s.key) ?? { label: s.label, places: new Map(), total: 0 };
      e.places.set(s.place, (e.places.get(s.place) ?? 0) + 1);
      e.total++;
      e.label = s.label;
      byKey.set(s.key, e);
    }
    const habits: Habit[] = [];
    for (const [key, e] of byKey) {
      let best = '';
      let count = 0;
      for (const [p, c] of e.places) if (c > count) [best, count] = [p, c];
      if (count >= 2) habits.push({ key, label: e.label, place: best, count, total: e.total });
    }
    return habits.sort((a, b) => b.count - a.count);
  }

  habitFor(query: string): Habit | null {
    const q = normalizeName(query);
    return this.learnHabits().find((h) => h.key === q || h.key.includes(q) || q.includes(h.key)) ?? null;
  }

  setShortTerm(text: string, at = Date.now()): void {
    this.shortTerm = { at, text };
    this.emit();
  }

  addDiary(text: string, at = Date.now()): void {
    this.diary.push({ at, text });
    if (this.diary.length > 200) this.diary.shift();
    this.emit();
  }

  eventsSince(at: number): SceneEvent[] {
    return this.events.filter((e) => e.at > at);
  }

  /** Compact memory context for the Communicator prompt. */
  contextForPrompt(now = Date.now()): string {
    const lines: string[] = [];
    const seen = Object.values(this.lastSeen).sort((a, b) => b.at - a.at).slice(0, 40);
    if (seen.length) {
      lines.push('LAST SEEN OBJECTS (most recent first):');
      for (const s of seen) {
        lines.push(
          `- ${s.label}: ${s.held ? 'in the user\'s hand' : s.location}` +
            (s.near.length ? ` (near ${s.near.join(', ')})` : '') +
            ` - ${timeAgo(now - s.at)}`,
        );
      }
    }
    const habits = this.learnHabits().slice(0, 15);
    if (habits.length) {
      lines.push('HABITS:');
      for (const h of habits) lines.push(`- ${h.label} usually at ${h.place} (${h.count}/${h.total} sightings)`);
    }
    if (this.shortTerm) lines.push(`RECENT SUMMARY (${timeAgo(now - this.shortTerm.at)}): ${this.shortTerm.text}`);
    const recent = this.events.slice(-25);
    if (recent.length) {
      lines.push('RECENT EVENTS:');
      for (const e of recent) lines.push(`- [${timeAgo(now - e.at)}] ${e.text}`);
    }
    const diary = this.diary.slice(-5);
    if (diary.length) {
      lines.push('DIARY:');
      for (const d of diary) lines.push(`- [${timeAgo(now - d.at)}] ${d.text}`);
    }
    return lines.join('\n') || 'No memories yet.';
  }

  snapshot(): MemorySnapshot {
    return {
      v: 1,
      events: this.events,
      lastSeen: this.lastSeen,
      history: this.history,
      shortTerm: this.shortTerm,
      diary: this.diary,
    };
  }

  load(s: MemorySnapshot | null | undefined): void {
    if (!s || s.v !== 1) return;
    this.events = s.events ?? [];
    this.lastSeen = s.lastSeen ?? {};
    this.history = s.history ?? [];
    this.shortTerm = s.shortTerm ?? null;
    this.diary = s.diary ?? [];
    this.emit();
  }

  clear(): void {
    this.load({ v: 1, events: [], lastSeen: {}, history: [], shortTerm: null, diary: [] });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}
