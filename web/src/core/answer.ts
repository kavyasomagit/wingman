import type { MemoryStore } from './memory';
import { formatWhereAnswer } from './format';
import { sanitizeSpeech } from './safety';

export interface AskLike {
  intent: string;
  object: string;
  answer: string;
}

/**
 * Communicator answer policy (R5.3, R8):
 * "where is X" is answered from the most recent sighting with exact timing;
 * everything else uses the model's answer. All output passes the safety filter.
 */
export function resolveAnswer(res: AskLike, store: MemoryStore, now = Date.now()): string {
  if (res.intent === 'where_is' && res.object.trim()) {
    const s = store.whereIs(res.object);
    if (s) return sanitizeSpeech(formatWhereAnswer(s, now));
    const habit = store.habitFor(res.object);
    if (habit && !res.answer.trim()) {
      return sanitizeSpeech(`I haven't seen your ${res.object} recently. They're usually at the ${habit.place}.`);
    }
  }
  return sanitizeSpeech(res.answer.trim() || "Sorry, I didn't catch that. Please try again.");
}
