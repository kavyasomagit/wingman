import { useEffect, useMemo, useRef, useState } from 'react';
import { MemoryStore, type MemorySnapshot } from './core/memory';
import { SpeechQueue } from './core/speechQueue';
import { timeAgo } from './core/format';
import {
  Communicator,
  Guardian,
  LongTermMemory,
  PerceptionLoop,
  SceneLogger,
  ShortTermMemory,
  type CommState,
  type FrameSource,
  type Recorder,
} from './agents';
import { api, getCode, setCode } from './api';
import { LiveClient } from './live';
import {
  browserHaptics,
  browserSpeaker,
  cameraFrames,
  changedFramesOnly,
  keepAwake,
  mediaRecorder,
  openMedia,
  startMicStream,
} from './browser';

const MEMORY_KEY = 'iris.memory.v1';

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const media = useRef<MediaStream | null>(null);
  const stopMic = useRef<(() => void) | null>(null);
  const frameRef = useRef<FrameSource | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const changedRef = useRef<(FrameSource & { skipped: number }) | null>(null);

  const sys = useMemo(() => {
    const store = new MemoryStore();
    try {
      const raw = localStorage.getItem(MEMORY_KEY);
      if (raw) store.load(JSON.parse(raw) as MemorySnapshot);
    } catch {}
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    store.subscribe(() => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => localStorage.setItem(MEMORY_KEY, JSON.stringify(store.snapshot())), 1500);
    });

    const queue = new SpeechQueue(browserSpeaker);
    // Questions always get a fresh frame; the perception loop only sends frames that changed.
    const frames: FrameSource = { capture: () => frameRef.current?.capture() ?? Promise.resolve(null) };
    const changed = { skipped: 0, capture: () => changedRef.current?.capture() ?? Promise.resolve(null) };
    const recorder: Recorder = {
      start: () => recRef.current!.start(),
      stop: () => recRef.current!.stop(),
    };
    const perception = new PerceptionLoop(changed, 5000);
    const guardian = new Guardian(queue, browserHaptics);
    const logger = new SceneLogger(store);
    const stm = new ShortTermMemory(store, 60_000);
    const ltm = new LongTermMemory(store, 5 * 60_000);
    const comm = new Communicator(store, queue, frames, recorder, browserHaptics);
    const live = new LiveClient(queue, () => store.contextForPrompt());
    perception.onFrame((f) => live.sendFrame(f));

    // Echo guard: stream silence while Iris speaks so the Live model doesn't hear itself.
    let speaking = false;
    let lastSpokeAt = 0;
    queue.subscribe((s) => {
      if (speaking && !s.speaking) lastSpokeAt = Date.now();
      speaking = s.speaking;
    });
    const mic = { muted: false };
    const onMic = (pcm: Int16Array) => {
      if (mic.muted) return;
      const echo = speaking || Date.now() - lastSpokeAt < 700;
      live.sendAudio(echo ? new Int16Array(pcm.length) : pcm);
    };

    const recentAlerts: { at: number; text: string }[] = [];
    const stats = { frameMs: 0 };
    perception.onResult(({ at, result, ms }) => {
      stats.frameMs = ms;
      for (const text of guardian.handle(result, Date.now() - at)) {
        recentAlerts.unshift({ at: Date.now(), text });
        recentAlerts.splice(5);
      }
      logger.handle(result, at);
    });
    return { store, queue, perception, guardian, logger, stm, ltm, comm, live, onMic, mic, recentAlerts, stats };
  }, []);

  const [started, setStarted] = useState(false);
  const [error, setError] = useState('');
  const [codeRequired, setCodeRequired] = useState(false);
  const [code, setCodeInput] = useState(getCode());
  const [mode, setMode] = useState<'live' | 'ptt'>('live');
  const [muted, setMuted] = useState(false);
  const [commState, setCommState] = useState<CommState>('idle');
  const [question, setQuestion] = useState('');
  const [, setTick] = useState(0);
  const rerender = () => setTick((n) => n + 1);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('code');
    if (fromUrl) {
      setCode(fromUrl);
      setCodeInput(fromUrl);
    }
    void api.health().then((h) => setCodeRequired(!!h?.codeRequired));
    const t = setInterval(rerender, 1000);
    const u1 = sys.comm.onState(setCommState);
    const u2 = sys.live.subscribe(rerender);
    const u3 = sys.store.subscribe(rerender);
    return () => {
      clearInterval(t);
      u1();
      u2();
      u3();
    };
  }, [sys]);

  const start = async () => {
    setError('');
    setCode(code);
    // Speak inside the tap so iOS Safari unlocks speech.
    sys.queue.say('Starting Iris.');
    try {
      media.current = await openMedia(videoRef.current!);
    } catch (e) {
      setError(`Camera or microphone blocked: ${(e as Error).message}. Allow both and try again.`);
      return;
    }
    frameRef.current = cameraFrames(videoRef.current!);
    changedRef.current = changedFramesOnly(videoRef.current!, frameRef.current);
    recRef.current = mediaRecorder(media.current);
    const h = await api.health();
    if (!h?.ok) {
      setError('Iris server is not reachable or not configured.');
      return;
    }
    setStarted(true);
  };

  // Agents lifecycle
  useEffect(() => {
    if (!started) return;
    const releaseWake = keepAwake();
    sys.perception.start();
    sys.stm.start();
    sys.ltm.start();
    return () => {
      releaseWake();
      sys.perception.stop();
      sys.stm.stop();
      sys.ltm.stop();
    };
  }, [started, sys]);

  // Live mode lifecycle
  useEffect(() => {
    if (!started || mode !== 'live' || !media.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const stop = await startMicStream(media.current!, sys.onMic);
        if (cancelled) return stop();
        stopMic.current = stop;
        sys.live.connect();
        sys.queue.say('Iris is watching and listening. Say Iris, then your question.');
      } catch (e) {
        setError(`Live listening failed (${(e as Error).message}). Switched to push to talk.`);
        setMode('ptt');
      }
    })();
    return () => {
      cancelled = true;
      sys.live.disconnect();
      stopMic.current?.();
      stopMic.current = null;
    };
  }, [started, mode, sys]);

  useEffect(() => {
    if (started && mode === 'ptt') sys.queue.say('Push to talk. Hold the yellow button and ask.');
  }, [started, mode, sys]);

  // Big button: Live = pause/resume; PTT = hold to talk, or tap to start / tap to stop.
  const pressAt = useRef(0);
  const ignoreUp = useRef(false);
  const down = () => {
    if (mode === 'live') {
      sys.mic.muted = !sys.mic.muted;
      setMuted(sys.mic.muted);
      sys.queue.say(sys.mic.muted ? 'Listening paused.' : 'Listening.');
      return;
    }
    if (sys.comm.state === 'listening') {
      ignoreUp.current = true;
      void sys.comm.stopAndAnswer();
    } else if (sys.comm.state === 'idle') {
      pressAt.current = Date.now();
      void sys.comm.startListening();
    }
  };
  const up = () => {
    if (mode === 'live') return;
    if (ignoreUp.current) {
      ignoreUp.current = false;
      return;
    }
    if (sys.comm.state === 'listening' && Date.now() - pressAt.current >= 450) void sys.comm.stopAndAnswer();
  };

  const live = sys.live;
  const now = Date.now();
  const label =
    mode === 'live'
      ? muted
        ? 'Listening paused. Tap to resume'
        : live.state === 'ready'
          ? 'Listening. Say "Iris, …"'
          : live.state === 'error'
            ? 'Live unavailable. Switch to push-to-talk below'
            : 'Connecting…'
      : commState === 'listening'
        ? 'Listening… release to ask'
        : commState === 'thinking'
          ? 'Thinking…'
          : 'Hold to ask Iris';
  const q = sys.queue.state;
  const seen = Object.values(sys.store.lastSeen).sort((a, b) => b.at - a.at).slice(0, 8);
  const habits = sys.store.learnHabits().slice(0, 4);

  return (
    <main>
      <section className="camera" aria-label="Camera preview">
        <video ref={videoRef} playsInline muted aria-hidden="true" />
        {started ? (
          <div className="overlay">
            <div>{sys.logger.lastScene || 'Looking…'}</div>
            <small>
              {sys.perception.lastError ? `⚠ ${sys.perception.lastError.slice(0, 70)}` : `frame ${sys.stats.frameMs} ms`}
              {changedRef.current?.skipped ? ` · ${changedRef.current.skipped} unchanged frames skipped` : ''}
            </small>
          </div>
        ) : null}
      </section>

      {!started ? (
        <section className="intro">
          <h1>Iris</h1>
          <p className="tag">A seeing companion that remembers. Use with your cane or guide dog.</p>
          <ol className="howto">
            <li>Allow camera and microphone. On a phone, point the rear camera forward (or wear it on a lanyard).</li>
            <li>Show an object such as keys, a phone, or a mug, then put it down somewhere and walk away.</li>
            <li>Say <b>"Iris, where are my keys?"</b> or <b>"Iris, what's in front of me?"</b></li>
            <li>Walk toward a chair or a step: Iris warns you without being asked.</li>
          </ol>
          {codeRequired ? (
            <label className="code">
              Access code
              <input value={code} onChange={(e) => setCodeInput(e.target.value)} autoComplete="off" />
            </label>
          ) : null}
          <button className="start" onClick={start} aria-label="Start Iris">
            Start Iris
          </button>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <p className="small">Works best in Chrome (Android/desktop) or Safari (iOS). Sound on.</p>
        </section>
      ) : (
        <>
          <button
            className={[
              'talk',
              commState === 'listening' || (mode === 'live' && live.heard) ? 'listening' : '',
              commState === 'thinking' || (mode === 'live' && live.state !== 'ready') ? 'thinking' : '',
              mode === 'live' && muted ? 'muted' : '',
            ].join(' ')}
            onPointerDown={down}
            onPointerUp={up}
            onPointerLeave={up}
            onContextMenu={(e) => e.preventDefault()}
            aria-label={label}
          >
            <span className="label">{label}</span>
            {mode === 'live' && live.heard ? <span className="sub">🗣 {live.heard}</span> : null}
            {q.speaking ? (
              <span className="sub" aria-live="polite">
                {q.priority === 'alert' ? '⚠ ' : '🔊 '}
                {q.text}
              </span>
            ) : null}
          </button>

          <section className="panel">
            {error ? <p className="error" role="alert">{error}</p> : null}
            {mode === 'live' ? (
              <>
                <p className="dim">
                  Live: {live.state} · {live.requireWake ? 'needs "Iris"' : 'answers everything'}
                  {live.lastError ? ` · ${live.lastError}` : ''}
                </p>
                {live.lastHeard ? <p>🗣 {live.lastHeard}</p> : null}
                {live.lastAnswer ? <p>💬 {live.lastAnswer}</p> : null}
                {live.lastIgnored ? <p className="dim">ignored (no "Iris"): {live.lastIgnored}</p> : null}
              </>
            ) : (
              <>
                {sys.comm.lastTranscript ? <p>🗣 {sys.comm.lastTranscript}</p> : null}
                {sys.comm.lastAnswer ? <p>💬 {sys.comm.lastAnswer}</p> : null}
              </>
            )}

            <h2>Guardian alerts</h2>
            {sys.recentAlerts.length ? (
              sys.recentAlerts.map((a) => (
                <p key={a.at + a.text}>
                  ⚠ {a.text} <span className="dim">{timeAgo(now - a.at)}</span>
                </p>
              ))
            ) : (
              <p className="dim">none yet</p>
            )}

            <h2>Last seen</h2>
            {seen.length ? (
              seen.map((s) => (
                <p key={s.key}>
                  {s.label}: {s.held ? 'in hand' : s.location} <span className="dim">{timeAgo(now - s.at)}</span>
                </p>
              ))
            ) : (
              <p className="dim">nothing yet</p>
            )}

            <h2>Short-term memory</h2>
            <p className="dim">{sys.store.shortTerm?.text ?? `${sys.store.events.length} events logged`}</p>
            {habits.length ? <h2>Habits</h2> : null}
            {habits.map((h) => (
              <p key={h.key}>
                {h.label} → usually {h.place} ({h.count}/{h.total})
              </p>
            ))}
            {sys.store.diary.length ? <h2>Diary</h2> : null}
            {sys.store.diary.slice(-2).map((d) => (
              <p key={d.at} className="dim">
                {d.text}
              </p>
            ))}

            <h2>Controls</h2>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void sys.comm.askText(question);
                setQuestion('');
              }}
            >
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Or type a question"
                aria-label="Type a question"
              />
              <button type="submit">Ask</button>
            </form>
            <div className="row">
              <button
                onClick={() => {
                  sys.mic.muted = false;
                  setMuted(false);
                  setMode((m) => (m === 'live' ? 'ptt' : 'live'));
                }}
              >
                {mode === 'live' ? 'Switch to push-to-talk' : 'Switch to hands-free Live'}
              </button>
              {mode === 'live' ? (
                <button
                  onClick={() => {
                    live.requireWake = !live.requireWake;
                    rerender();
                  }}
                >
                  Wake word: {live.requireWake ? 'on' : 'off'}
                </button>
              ) : null}
              <button
                onClick={() => {
                  sys.queue.say(
                    'This is a long answer from the Communicator. There is a sofa on your left. There is a table ahead. A window is on your right.',
                  );
                  setTimeout(() => sys.queue.alert('Step down ahead.'), 2500);
                }}
              >
                Test interrupt
              </button>
              <button
                onClick={() => (sys.perception.isRunning ? sys.perception.stop() : sys.perception.start(), rerender())}
              >
                {sys.perception.isRunning ? 'Pause watching' : 'Resume watching'}
              </button>
              <button onClick={() => void sys.stm.tick().then(() => sys.ltm.tick())}>Summarize now</button>
              <button onClick={() => sys.store.clear()}>Clear memory</button>
            </div>
            <p className="small">
              Iris supplements a cane or guide dog and never says anything is "safe". Memory stays in this browser.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
