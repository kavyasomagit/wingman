/**
 * Property-based tests (fast-check) for Iris's core rules. Each property maps to a requirement in
 * .kiro/specs/iris/requirements.md and runs against hundreds of random scenarios.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SpeechQueue, type Speaker } from '../speechQueue';
import { AlertCooldown, type Urgency } from '../cooldown';
import { MemoryStore, normalizeName } from '../memory';
import { sanitizeSpeech } from '../safety';

class FakeSpeaker implements Speaker {
  log: string[] = [];
  done: (() => void) | null = null;
  current: string | null = null;
  speak(text: string, onDone: () => void) {
    this.log.push(text);
    this.current = text;
    this.done = onDone;
  }
  stop() {
    const d = this.done;
    this.done = null;
    this.current = null;
    d?.();
  }
  finish() {
    const d = this.done;
    this.done = null;
    this.current = null;
    d?.();
  }
}

type Op = { k: 'say'; n: number } | { k: 'alert' } | { k: 'finish' };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constant('say' as const), n: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ k: fc.constant('alert' as const) }),
  fc.record({ k: fc.constant('finish' as const) }),
);

describe('PBT R7: priority speech queue', () => {
  it('after any alert, an alert is speaking immediately; alerts are spoken once each, in order; no answer sentence is lost or reordered', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const sp = new FakeSpeaker();
        const q = new SpeechQueue(sp);
        const alerts: string[] = [];
        const answers: string[][] = [];
        for (const op of ops) {
          if (op.k === 'say') {
            const id = answers.length;
            const sentences = Array.from({ length: op.n }, (_, i) => `Answer ${id} sentence ${i}.`);
            answers.push(sentences);
            q.say(sentences.join(' '));
          } else if (op.k === 'alert') {
            const text = `Hazard ${alerts.length}.`;
            alerts.push(text);
            q.alert(text);
            // R7.2: an alert must be what's playing right now (it never waits behind an answer).
            expect(q.state.priority).toBe('alert');
          } else sp.finish();
        }
        for (let i = 0; i < 500 && sp.done; i++) sp.finish(); // drain
        expect(q.state.speaking).toBe(false);

        // R7.4: every alert spoken exactly once, in order.
        expect(sp.log.filter((t) => t.startsWith('Hazard'))).toEqual(alerts);

        // R7.3: each answer's sentences all play, in order; only an interrupted sentence may repeat.
        for (const [id, sentences] of answers.entries()) {
          const spoken = sp.log.filter((t) => t.startsWith(`Answer ${id} `));
          const deduped = spoken.filter((t, i) => t !== spoken[i - 1]);
          expect(deduped).toEqual(sentences);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe('PBT R6.3: alert cooldown', () => {
  const RANK: Record<Urgency, number> = { low: 0, medium: 1, high: 2 };
  it('never lets the same hazard through twice within the cooldown unless urgency rises', () => {
    const event = fc.record({
      dt: fc.integer({ min: 0, max: 8000 }),
      key: fc.constantFrom('stairs_down', 'vehicle', 'obstacle_ahead', 'Stairs Down'),
      urgency: fc.constantFrom<Urgency>('low', 'medium', 'high'),
    });
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), (events) => {
        let t = 0;
        const c = new AlertCooldown(15_000, () => t);
        const last = new Map<string, { at: number; urgency: Urgency }>();
        for (const e of events) {
          t += e.dt;
          const key = e.key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
          if (c.shouldAlert(e.key, e.urgency)) {
            const prev = last.get(key);
            if (prev && t - prev.at < 15_000) expect(RANK[e.urgency]).toBeGreaterThan(RANK[prev.urgency]);
            last.set(key, { at: t, urgency: e.urgency });
          }
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe('PBT R2.3 / R5.3: where-is returns the most recent sighting', () => {
  it('for any sightings arriving in any order, whereIs returns the newest one for that object', () => {
    const sighting = fc.record({
      label: fc.constantFrom('keys', 'key', 'my keys', 'phone', 'glasses', 'red mug', 'wallet'),
      location: fc.constantFrom('on the counter', 'on the desk', 'on the hook by the door', 'in the bag'),
      at: fc.integer({ min: 0, max: 1_000_000 }),
      held: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(sighting, { minLength: 1, maxLength: 30 }), (list) => {
        const m = new MemoryStore();
        for (const s of list) m.recordSighting({ ...s, near: [] });
        for (const s of list) {
          const key = normalizeName(s.label);
          const newest = Math.max(...list.filter((x) => normalizeName(x.label) === key).map((x) => x.at));
          expect(m.whereIs(s.label)?.at).toBe(newest);
          expect(m.whereIs(`my ${s.label}`)?.at).toBe(newest);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('PBT R8: safety language', () => {
  const sentence = fc.constantFrom(
    'There is a crosswalk ahead.',
    'The light is green.',
    'A car is parked on your left.',
    "It's safe to cross.",
    'All clear ahead.',
    'You can cross safely now.',
    'It is not safe to walk here.',
    'Step down ahead.',
    "I can't judge whether it's safe.",
    'Please rely on your cane, guide dog, or crossing signals.',
  );
  const text = fc.array(sentence, { minLength: 1, maxLength: 6 }).map((a) => a.join(' '));

  it('never outputs a claim that something is safe', () => {
    fc.assert(
      fc.property(text, (t) => {
        const out = sanitizeSpeech(t);
        expect(out).not.toMatch(/safe to cross|all clear|cross safely/i);
      }),
      { numRuns: 400 },
    );
  });

  it('is idempotent: filtering twice changes nothing (no duplicated reminders)', () => {
    fc.assert(
      fc.property(text, (t) => {
        const once = sanitizeSpeech(t);
        expect(sanitizeSpeech(once)).toBe(once);
      }),
      { numRuns: 400 },
    );
  });
});
