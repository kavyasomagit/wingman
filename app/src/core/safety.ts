/** Last line of defence for R8: Iris never claims something is safe. */
export const SAFETY_DISCLAIMER =
  "I can't judge whether it's safe. Please rely on your cane, guide dog, or crossing signals.";

const SAFE_CLAIM = /\b(safe|safely|all clear|coast is clear|clear to (cross|go|walk))\b/i;
const NEGATED = /\b(not|never|isn't|is not|aren't|n't|un)\s*(\w+\s+){0,2}(safe|clear)/i;
const DISCLAIMER_PARTS = SAFETY_DISCLAIMER.match(/[^.!?]+[.!?]*/g)!.map((s) => s.trim());

/**
 * Replaces any sentence claiming safety with the disclaimer (added once).
 * Idempotent (found by property-based testing): the disclaimer's own sentences are kept as-is
 * and never duplicated, so filtering twice, or a model that already gave the reminder,
 * doesn't repeat it.
 */
export function sanitizeSpeech(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const out: string[] = [];
  const has = new Set<string>();
  const addDisclaimer = () => {
    for (const p of DISCLAIMER_PARTS) {
      if (!has.has(p)) {
        out.push(p);
        has.add(p);
      }
    }
  };
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (DISCLAIMER_PARTS.includes(s)) {
      if (!has.has(s)) {
        out.push(s);
        has.add(s);
      }
    } else if (SAFE_CLAIM.test(s) && !NEGATED.test(s)) {
      addDisclaimer();
    } else {
      out.push(s);
    }
  }
  return out.join(' ');
}
