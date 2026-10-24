import type { Sighting } from './memory';

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m <= 1) return 'about a minute ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h <= 1) return 'about an hour ago';
  if (h < 24) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return d <= 1 ? 'yesterday' : `${d} days ago`;
}

function isPlural(label: string): boolean {
  const w = label.trim().toLowerCase().split(/\s+/).pop() ?? '';
  return (/s$/.test(w) && !/ss$/.test(w)) || ['glasses', 'headphones', 'earbuds'].includes(w);
}

function withPreposition(loc: string): string {
  const l = loc.trim().replace(/[.]+$/, '');
  if (/^(on|in|under|next to|near|beside|by|inside|behind|at|between|against|over|on top of)\b/i.test(l)) return l;
  return `at ${l}`;
}

/** Deterministic spoken answer for "where is X" (R5.3). */
export function formatWhereAnswer(s: Sighting, now: number): string {
  const ago = timeAgo(now - s.at);
  const plural = isPlural(s.label);
  const pron = plural ? 'them' : 'it';
  const near = s.near.filter(Boolean).slice(0, 2);
  const nearText = near.length ? `, near the ${near.join(' and the ')}` : '';
  if (s.held) {
    const where = s.location ? ` You were ${withPreposition(s.location)}.` : '';
    return `The last time I saw your ${s.label}, you were holding ${pron}, ${ago}.${where}`;
  }
  const loc = s.location ? withPreposition(s.location) : 'somewhere nearby';
  return `Your ${s.label} ${plural ? 'were' : 'was'} ${loc}${nearText}. I saw ${pron} ${ago}.`;
}
