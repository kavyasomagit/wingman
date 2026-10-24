/** Alert cooldown (R6.3): the same hazard is not repeated within cooldownMs,
 * unless it escalates to a more urgent level. */
export type Urgency = 'low' | 'medium' | 'high';

const RANK: Record<Urgency, number> = { low: 0, medium: 1, high: 2 };

export function hazardKey(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export class AlertCooldown {
  private last = new Map<string, { at: number; urgency: Urgency }>();

  constructor(
    private cooldownMs = 15_000,
    private now: () => number = () => Date.now(),
  ) {}

  /** Returns true if an alert should be spoken now, and records it. */
  shouldAlert(type: string, urgency: Urgency = 'medium'): boolean {
    const key = hazardKey(type);
    const t = this.now();
    const prev = this.last.get(key);
    if (prev && t - prev.at < this.cooldownMs && RANK[urgency] <= RANK[prev.urgency]) {
      return false;
    }
    this.last.set(key, { at: t, urgency });
    return true;
  }

  reset(): void {
    this.last.clear();
  }
}
