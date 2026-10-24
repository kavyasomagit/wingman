import type { Urgency } from './core/cooldown';

export interface Hazard {
  type: string;
  urgency: Urgency;
  message: string;
}
export interface SeenObject {
  name: string;
  location: string;
  place: string;
  near?: string[];
  held: boolean;
}
export interface Perception {
  hazards: Hazard[];
  objects: SeenObject[];
  events: string[];
  scene: string;
}
export type Intent = 'where_is' | 'describe' | 'read_text' | 'memory' | 'other';
export interface AskResult {
  transcript: string;
  intent: Intent;
  object: string;
  answer: string;
}
export interface LiveTokenResult {
  url: string;
  setup: Record<string, unknown>;
}

const CODE_KEY = 'iris.code';
export function getCode(): string {
  return localStorage.getItem(CODE_KEY) ?? '';
}
export function setCode(code: string): void {
  localStorage.setItem(CODE_KEY, code.trim());
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-iris-code': getCode() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} ${res.status}: ${json?.error ?? 'error'}`);
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  perceive: (image: string) => post<Perception>('/api/perceive', { image }, 12_000),
  ask: (p: { audio?: string; audioMime?: string; question?: string; image?: string | null; memory: string }) =>
    post<AskResult>('/api/ask', p, 25_000),
  summarize: (kind: 'short' | 'diary', events: string, previous?: string) =>
    post<{ summary: string }>('/api/summarize', { kind, events, previous }, 30_000),
  liveToken: (memory: string) => post<LiveTokenResult>('/api/live-token', { memory }, 10_000),
  health: async (): Promise<{ ok: boolean; codeRequired: boolean } | null> => {
    try {
      const r = await fetch('/api/health');
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
};
