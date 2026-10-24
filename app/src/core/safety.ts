/** Last line of defence for R8: Iris never claims something is safe. */
export const SAFETY_DISCLAIMER =
  "I can't judge whether it's safe. Please rely on your cane, guide dog, or crossing signals.";

const SAFE_CLAIM = /\b(safe|safely|all clear|coast is clear|clear to (cross|go|walk))\b/i;
const NEGATED = /\b(not|never|isn't|is not|aren't|n't|un)\s*(\w+\s+){0,2}(safe|clear)/i;

export function sanitizeSpeech(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  let replaced = false;
  const out: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (SAFE_CLAIM.test(s) && !NEGATED.test(s)) {
      if (!replaced) out.push(SAFETY_DISCLAIMER);
      replaced = true;
    } else {
      out.push(s);
    }
  }
  return out.join(' ');
}
