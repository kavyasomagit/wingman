import { describe, it, expect, beforeEach } from 'vitest';
import { SpeechQueue, type Speaker } from '../speechQueue';
import { AlertCooldown } from '../cooldown';
import { MemoryStore } from '../memory';
import { resolveAnswer } from '../answer';
import { sanitizeSpeech, SAFETY_DISCLAIMER } from '../safety';

/** Fake speaker: records what was spoken; test calls finish() to end the current utterance. */
class FakeSpeaker implements Speaker {
  log: string[] = [];
  stops = 0;
  current: { text: string; done: () => void } | null = null;
  speak(text: string, onDone: () => void) {
    this.log.push(text);
    this.current = { text, done: onDone };
  }
  stop() {
    this.stops++;
    const c = this.current;
    this.current = null;
    c?.done(); // like expo-speech firing onStopped; must be ignored by the queue
  }
  finish() {
    const c = this.current;
    this.current = null;
    c?.done();
  }
}

describe('SpeechQueue: hazards always interrupt other speech (R7)', () => {
  let sp: FakeSpeaker;
  let q: SpeechQueue;
  beforeEach(() => {
    sp = new FakeSpeaker();
    q = new SpeechQueue(sp);
  });

  it('interrupts a Communicator answer immediately', () => {
    q.say('Your keys are on the counter. I saw them 4 minutes ago.');
    expect(sp.current?.text).toBe('Your keys are on the counter.');
    q.alert('Step down ahead.');
    expect(sp.stops).toBe(1);
    expect(sp.current?.text).toBe('Step down ahead.');
    expect(q.state.priority).toBe('alert');
  });

  it('resumes the interrupted answer from the interrupted sentence', () => {
    q.say('First sentence. Second sentence. Third sentence.');
    sp.finish(); // first done
    expect(sp.current?.text).toBe('Second sentence.');
    q.alert('Obstacle ahead.');
    sp.finish(); // alert done
    expect(sp.current?.text).toBe('Second sentence.');
    sp.finish();
    expect(sp.current?.text).toBe('Third sentence.');
    sp.finish();
    expect(q.state.speaking).toBe(false);
    expect(sp.log).toEqual([
      'First sentence.',
      'Second sentence.',
      'Obstacle ahead.',
      'Second sentence.',
      'Third sentence.',
    ]);
  });

  it('speaks alerts before queued normal speech', () => {
    q.say('Answer one.');
    q.say('Answer two.');
    q.alert('Car approaching.');
    sp.finish();
    expect(sp.log).toEqual(['Answer one.', 'Car approaching.', 'Answer one.']);
    sp.finish();
    expect(sp.current?.text).toBe('Answer two.');
  });

  it('does not let one alert cut off another; alerts queue in order', () => {
    q.alert('Step down ahead.');
    q.alert('Chair on your left.');
    expect(sp.stops).toBe(0);
    sp.finish();
    expect(sp.current?.text).toBe('Chair on your left.');
  });

  it('ignores stale onDone from the interrupted utterance', () => {
    q.say('Long answer one. Long answer two.');
    q.alert('Step down ahead.');
    // FakeSpeaker.stop() already fired the stale onDone; the alert must still be current
    expect(sp.current?.text).toBe('Step down ahead.');
    expect(sp.log.filter((t) => t === 'Long answer two.')).toHaveLength(0);
  });

  it('a new question (cancelNormal) drops answers but keeps alerts', () => {
    q.alert('Pole ahead.');
    q.say('Old answer.');
    q.cancelNormal();
    sp.finish();
    expect(q.state.speaking).toBe(false);
    expect(sp.log).toEqual(['Pole ahead.']);
  });
});

describe('AlertCooldown: alerts are not repeated within the cooldown (R6.3)', () => {
  it('suppresses the same hazard within the cooldown and allows it after', () => {
    let t = 0;
    const c = new AlertCooldown(15_000, () => t);
    expect(c.shouldAlert('stairs_down', 'medium')).toBe(true);
    t = 5_000;
    expect(c.shouldAlert('stairs_down', 'medium')).toBe(false);
    t = 14_999;
    expect(c.shouldAlert('Stairs Down', 'medium')).toBe(false); // same key after normalisation
    t = 15_000;
    expect(c.shouldAlert('stairs_down', 'medium')).toBe(true);
  });

  it('tracks hazard types independently', () => {
    let t = 0;
    const c = new AlertCooldown(15_000, () => t);
    expect(c.shouldAlert('stairs_down')).toBe(true);
    t = 1000;
    expect(c.shouldAlert('vehicle')).toBe(true);
  });

  it('lets an escalation to higher urgency through, but not a repeat of it', () => {
    let t = 0;
    const c = new AlertCooldown(15_000, () => t);
    expect(c.shouldAlert('vehicle', 'medium')).toBe(true);
    t = 2000;
    expect(c.shouldAlert('vehicle', 'high')).toBe(true);
    t = 4000;
    expect(c.shouldAlert('vehicle', 'high')).toBe(false);
    expect(c.shouldAlert('vehicle', 'medium')).toBe(false);
  });
});

describe('MemoryStore.whereIs: returns the most recent sighting (R2.3, R5.3)', () => {
  const sighting = (label: string, location: string, at: number, held = false) => ({
    label,
    location,
    place: location.replace(/^on (the )?/, ''),
    near: [],
    held,
    at,
  });

  it('returns the newest sighting, regardless of insertion order', () => {
    const m = new MemoryStore();
    m.recordSighting(sighting('keys', 'on the hook by the door', 1000));
    m.recordSighting(sighting('keys', 'on the kitchen counter', 5000));
    m.recordSighting(sighting('keys', 'on the sofa', 3000)); // older frame arriving late
    expect(m.whereIs('keys')?.location).toBe('on the kitchen counter');
  });

  it('matches name variants: "my keys", "key", "car keys"', () => {
    const m = new MemoryStore();
    m.recordSighting(sighting('keys', 'on the kitchen counter', 1000));
    expect(m.whereIs('my keys')?.location).toBe('on the kitchen counter');
    expect(m.whereIs('key')?.location).toBe('on the kitchen counter');
    expect(m.whereIs('car keys')?.location).toBe('on the kitchen counter');
  });

  it('picks the most recent among several matching objects', () => {
    const m = new MemoryStore();
    m.recordSighting(sighting('house keys', 'on the hook', 1000));
    m.recordSighting(sighting('car keys', 'on the desk', 9000));
    expect(m.whereIs('keys')?.location).toBe('on the desk');
  });

  it('returns null for never-seen objects', () => {
    const m = new MemoryStore();
    m.recordSighting(sighting('keys', 'on the counter', 1000));
    expect(m.whereIs('wallet')).toBeNull();
  });

  it('Communicator answers where-is from memory with the time since seen', () => {
    const m = new MemoryStore();
    const now = 10 * 60_000;
    m.recordSighting({ ...sighting('keys', 'on the kitchen counter', now - 4 * 60_000), near: ['red mug'] });
    const answer = resolveAnswer({ intent: 'where_is', object: 'keys', answer: 'model text' }, m, now);
    expect(answer).toBe('Your keys were on the kitchen counter, near the red mug. I saw them 4 minutes ago.');
  });

  it('learns habits from repeated places', () => {
    const m = new MemoryStore();
    m.recordSighting(sighting('keys', 'on hook by the door', 1));
    m.recordSighting(sighting('keys', 'on kitchen counter', 2));
    m.recordSighting(sighting('keys', 'on hook by the door', 3));
    expect(m.habitFor('keys')?.place).toBe('hook by the door');
  });

  it('survives a snapshot/load round trip (persistence)', () => {
    const a = new MemoryStore();
    a.recordSighting(sighting('glasses', 'on the nightstand', 42));
    const b = new MemoryStore();
    b.load(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.whereIs('glasses')?.at).toBe(42);
  });
});

describe('sanitizeSpeech: never claims something is safe (R8)', () => {
  it('replaces safety claims', () => {
    expect(sanitizeSpeech("The light is green. It's safe to cross.")).toBe(`The light is green. ${SAFETY_DISCLAIMER}`);
    expect(sanitizeSpeech('All clear ahead.')).toBe(SAFETY_DISCLAIMER);
  });
  it('keeps warnings and neutral text', () => {
    expect(sanitizeSpeech('It is not safe to walk here.')).toBe('It is not safe to walk here.');
    expect(sanitizeSpeech('Step down ahead.')).toBe('Step down ahead.');
  });
});
