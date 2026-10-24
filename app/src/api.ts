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

let baseUrl = (process.env.EXPO_PUBLIC_IRIS_API_URL || 'http://localhost:8787').replace(/\/+$/, '');
export const token = process.env.EXPO_PUBLIC_IRIS_TOKEN || '';

export function getBaseUrl(): string {
  return baseUrl;
}
export function setBaseUrl(url: string): void {
  baseUrl = url.trim().replace(/\/+$/, '');
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-iris-token': token } : {}) },
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
  diag: (payload: unknown) => post<{ ok: boolean }>('/api/diag', payload, 8_000),
  health: async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(baseUrl + '/health', { signal: ctrl.signal });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },
};
