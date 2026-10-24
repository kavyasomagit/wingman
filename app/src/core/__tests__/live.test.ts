import { describe, it, expect } from 'vitest';
import { LiveClient, addressedToIris } from '../../live';
import { SpeechQueue, type Speaker } from '../speechQueue';

class FakeSpeaker implements Speaker {
  log: string[] = [];
  done: (() => void) | null = null;
  speak(text: string, onDone: () => void) {
    this.log.push(text);
    this.done = onDone;
  }
  stop() {
    const d = this.done;
    this.done = null;
    d?.();
  }
  finishAll() {
    for (let i = 0; i < 20 && this.done; i++) {
      const d = this.done;
      this.done = null;
      d();
    }
  }
}

function setup(requireWake = true) {
  const sp = new FakeSpeaker();
  const q = new SpeechQueue(sp);
  const live = new LiveClient(q, () => 'http://x', () => '');
  live.requireWake = requireWake;
  const send = (m: object) => (live as any).handle(m);
  return { sp, q, live, send };
}

describe('Live hands-free mode', () => {
  it('detects the wake word, including common mis-hearings', () => {
    expect(addressedToIris('Iris, where are my keys?')).toBe(true);
    expect(addressedToIris('hey irish what is in front of me')).toBe(true);
    expect(addressedToIris('did you see the game last night')).toBe(false);
  });

  it('speaks answers addressed to Iris, sentence by sentence as text streams in', () => {
    const { sp, send } = setup();
    send({ type: 'heard', text: 'Iris, where are my keys?' });
    send({ type: 'text', text: 'Your keys are on the ' });
    expect(sp.log).toEqual([]); // no full sentence yet
    send({ type: 'text', text: 'counter. I saw them ' });
    expect(sp.log).toEqual(['Your keys are on the counter.']);
    send({ type: 'text', text: '4 minutes ago.' });
    send({ type: 'turn_complete' });
    sp.finishAll();
    expect(sp.log).toEqual(['Your keys are on the counter.', 'I saw them 4 minutes ago.']);
  });

  it('ignores background speech without the wake word', () => {
    const { sp, live, send } = setup();
    send({ type: 'heard', text: 'so anyway the demo is at five' });
    send({ type: 'text', text: 'Sounds good.' });
    send({ type: 'turn_complete' });
    expect(sp.log).toEqual([]);
    expect(live.lastIgnored).toBe('so anyway the demo is at five');
  });

  it('answers everything when the wake word is turned off', () => {
    const { sp, send } = setup(false);
    send({ type: 'heard', text: 'what is in front of me' });
    send({ type: 'text', text: 'A table with a red mug.' });
    send({ type: 'turn_complete' });
    expect(sp.log).toEqual(['A table with a red mug.']);
  });

  it('a Guardian alert still interrupts a Live answer', () => {
    const { sp, q, send } = setup(false);
    send({ type: 'heard', text: 'describe the room' });
    send({ type: 'text', text: 'A long description of the room. More details here.' });
    q.alert('Step down ahead.');
    expect(sp.log.at(-1)).toBe('Step down ahead.');
  });

  it('never speaks a safety claim from the Live model', () => {
    const { sp, send } = setup(false);
    send({ type: 'heard', text: 'can I cross' });
    send({ type: 'text', text: 'It is safe to cross now.' });
    send({ type: 'turn_complete' });
    expect(sp.log[0]).not.toMatch(/safe to cross/);
  });
});
