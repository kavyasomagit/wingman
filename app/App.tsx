import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioStream,
} from 'expo-audio';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { File } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { MemoryStore, type MemorySnapshot } from './src/core/memory';
import { SpeechQueue, type Speaker } from './src/core/speechQueue';
import { timeAgo } from './src/core/format';
import {
  Communicator,
  Guardian,
  LongTermMemory,
  PerceptionLoop,
  SceneLogger,
  ShortTermMemory,
  type CommState,
  type FrameSource,
  type Haptics as HapticsPort,
  type Recorder,
} from './src/agents';
import { api, getBaseUrl, setBaseUrl, token } from './src/api';
import { LiveClient } from './src/live';
import { runMicStreamTest } from './src/micStreamTest';

const MEMORY_KEY = 'iris.memory.v1';
const URL_KEY = 'iris.serverUrl';

const RECORDING_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64000 };

const expoSpeaker: Speaker = {
  speak(text, onDone) {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        onDone();
      }
    };
    Speech.speak(text, { rate: 1.0, onDone: finish, onStopped: finish, onError: finish });
  },
  stop() {
    void Speech.stop();
  },
};

const haptics: HapticsPort = {
  alert(urgency) {
    void Haptics.notificationAsync(
      urgency === 'high' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Warning,
    );
  },
  tick() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  },
};

export default function App() {
  useKeepAwake(); // R1.2
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micOk, setMicOk] = useState(false);
  const [started, setStarted] = useState(false);

  const cameraRef = useRef<CameraView>(null);
  const cameraReady = useRef(false);
  const audioRecorder = useAudioRecorder(RECORDING_OPTIONS);
  const recorderRef = useRef(audioRecorder);
  recorderRef.current = audioRecorder;

  // ---- one shared system: memory + speech queue + agents ----
  const sys = useMemo(() => {
    const store = new MemoryStore();
    const queue = new SpeechQueue(expoSpeaker);

    let inflight: Promise<string | null> | null = null;
    const frames: FrameSource = {
      capture() {
        const cam = cameraRef.current;
        if (!cam || !cameraReady.current) return Promise.resolve(null);
        if (inflight) return inflight; // camera can only take one picture at a time
        inflight = (async () => {
          const pic = await cam.takePictureAsync({ quality: 0.5, shutterSound: false });
          const small = await manipulateAsync(pic.uri, [{ resize: { width: 640 } }], {
            compress: 0.6,
            format: SaveFormat.JPEG,
            base64: true,
          });
          try {
            new File(pic.uri).delete();
            new File(small.uri).delete();
          } catch {}
          return small.base64 ?? null;
        })().finally(() => {
          inflight = null;
        });
        return inflight;
      },
    };

    let starting: Promise<void> | null = null;
    const recorder: Recorder = {
      async start() {
        starting = (async () => {
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          await recorderRef.current.prepareToRecordAsync();
          recorderRef.current.record();
        })();
        await starting;
      },
      async stop() {
        try {
          await starting;
        } catch {
          return null;
        }
        await recorderRef.current.stop();
        // Back to playback mode so speech uses the loudspeaker on iOS.
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        const uri = recorderRef.current.uri;
        if (!uri) return null;
        const file = new File(uri);
        const audio = await file.base64();
        try {
          file.delete();
        } catch {}
        return audio && audio.length > 1000 ? { audio, mime: 'audio/mp4' } : null;
      },
    };

    const perception = new PerceptionLoop(frames, 4000);
    const guardian = new Guardian(queue, haptics);
    const logger = new SceneLogger(store);
    const stm = new ShortTermMemory(store, 60_000);
    const ltm = new LongTermMemory(store, 5 * 60_000);
    const comm = new Communicator(store, queue, frames, recorder, haptics);

    const live = new LiveClient(queue, getBaseUrl, () => store.contextForPrompt(), token);
    perception.onFrame((f) => live.sendFrame(f));

    // Echo guard: while Iris is speaking (and shortly after), stream silence instead of the mic,
    // so the Live model doesn't hear Iris's own voice from the loudspeaker.
    let speaking = false;
    let lastSpokeAt = 0;
    queue.subscribe((s) => {
      if (speaking && !s.speaking) lastSpokeAt = Date.now();
      speaking = s.speaking;
    });
    let micMuted = false;
    const silence = new ArrayBuffer(3200);
    const onMic = (pcm: ArrayBuffer) => {
      if (micMuted) return;
      const echo = speaking || Date.now() - lastSpokeAt < 700;
      live.sendAudio(echo ? silence.slice(0, pcm.byteLength) : pcm);
    };

    const recentAlerts: { at: number; text: string }[] = [];
    let lastPerceptionMs = 0;
    perception.onResult(({ at, result, ms }) => {
      lastPerceptionMs = ms;
      for (const text of guardian.handle(result, Date.now() - at)) {
        recentAlerts.unshift({ at: Date.now(), text });
        recentAlerts.splice(5);
      }
      logger.handle(result, at);
    });

    return {
      store,
      queue,
      perception,
      guardian,
      logger,
      stm,
      ltm,
      comm,
      live,
      onMic,
      get micMuted() {
        return micMuted;
      },
      set micMuted(v: boolean) {
        micMuted = v;
      },
      recentAlerts,
      get perceptionMs() {
        return lastPerceptionMs;
      },
    };
  }, []);

  // ---- hands-free Live mode: continuous 16 kHz mic stream -> /live relay ----
  const { stream: micStream } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
    onBuffer: (b) => sys.onMic(b.data),
  });
  const [mode, setMode] = useState<'live' | 'ptt'>('live');
  const [micMuted, setMicMuted] = useState(false);

  const startLive = async () => {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    try {
      if (!micStream.isStreaming) await micStream.start();
    } catch (e) {
      console.warn('[live] mic stream', e);
      sys.queue.say("I couldn't start live listening. Switching to push to talk.");
      setMode('ptt');
      return;
    }
    sys.live.connect();
  };
  const stopLive = async () => {
    sys.live.disconnect();
    try {
      micStream.stop();
    } catch {}
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  };

  // ---- UI refresh ----
  const [, setTick] = useState(0);
  const [commState, setCommState] = useState<CommState>('idle');
  const [serverUrl, setServerUrl] = useState(getBaseUrl());
  const [question, setQuestion] = useState('');
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    const u1 = sys.comm.onState(setCommState);
    const u2 = sys.live.subscribe(() => setTick((n) => n + 1));
    return () => {
      clearInterval(t);
      u1();
      u2();
    };
  }, [sys]);

  // ---- load persisted memory + server URL, then autosave (R4.3) ----
  useEffect(() => {
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let unsub = () => {};
    (async () => {
      try {
        const [raw, url] = await Promise.all([AsyncStorage.getItem(MEMORY_KEY), AsyncStorage.getItem(URL_KEY)]);
        if (raw) sys.store.load(JSON.parse(raw) as MemorySnapshot);
        if (url) {
          setBaseUrl(url);
          setServerUrl(url);
        }
      } catch (e) {
        console.warn('[memory] load', e);
      }
      unsub = sys.store.subscribe(() => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(sys.store.snapshot())).catch(() => {});
        }, 2000);
      });
    })();
    return () => {
      unsub();
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [sys]);

  // ---- start / stop agents ----
  const startIris = async () => {
    const cam = camPerm?.granted ? camPerm : await requestCamPerm();
    const mic = await requestRecordingPermissionsAsync();
    setMicOk(mic.granted);
    if (!cam.granted) {
      sys.queue.say('Iris needs camera access to see.');
      return;
    }
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
    setStarted(true);
    const ok = await api.health();
    setServerOk(ok);
    sys.queue.say(
      !ok
        ? "I can't reach the Iris server. Check the server address."
        : mode === 'live'
          ? 'Iris is watching and listening. Say Iris, then your question.'
          : 'Iris is watching. Hold the screen to ask me anything.',
    );
  };

  // Live mode lifecycle + periodic memory refresh for the Live session.
  useEffect(() => {
    if (!started || mode !== 'live' || !micOk) return;
    void startLive();
    const t = setInterval(() => sys.live.sendMemory(), 15_000);
    return () => {
      clearInterval(t);
      void stopLive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, mode, micOk, sys]);

  useEffect(() => {
    if (!started) return;
    sys.perception.start();
    sys.stm.start();
    sys.ltm.start();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') sys.perception.start();
      else sys.perception.stop();
    });
    return () => {
      sub.remove();
      sys.perception.stop();
      sys.stm.stop();
      sys.ltm.stop();
    };
  }, [started, sys]);

  // ---- talk button: hold-to-talk, or tap to start / tap to stop (works with VoiceOver) ----
  const pressAt = useRef(0);
  const ignoreRelease = useRef(false);
  const onPressIn = () => {
    if (mode === 'live') {
      // Live mode: the big button pauses / resumes listening.
      const next = !sys.micMuted;
      sys.micMuted = next;
      setMicMuted(next);
      sys.queue.say(next ? 'Listening paused.' : 'Listening.');
      return;
    }
    if (sys.comm.state === 'listening') {
      ignoreRelease.current = true;
      void sys.comm.stopAndAnswer();
      return;
    }
    if (sys.comm.state === 'idle') {
      pressAt.current = Date.now();
      void sys.comm.startListening();
    }
  };
  const onPressOut = () => {
    if (mode === 'live') return;
    if (ignoreRelease.current) {
      ignoreRelease.current = false;
      return;
    }
    if (sys.comm.state === 'listening' && Date.now() - pressAt.current >= 450) void sys.comm.stopAndAnswer();
  };

  const saveUrl = async () => {
    setBaseUrl(serverUrl);
    await AsyncStorage.setItem(URL_KEY, getBaseUrl());
    const ok = await api.health();
    setServerOk(ok);
    sys.queue.say(ok ? 'Connected to Iris server.' : "I can't reach that server.");
  };

  const micTest = async () => {
    sys.queue.say('Mic stream test. Talk for four seconds.');
    await new Promise((r) => setTimeout(r, 2500));
    const res = await runMicStreamTest(4);
    console.log('[mic-stream-test]', JSON.stringify(res));
    api.diag({ test: 'mic-stream', ...res }).catch(() => {});
    sys.queue.say(
      res.ok
        ? `Mic stream works. ${res.buffers} buffers at ${res.sampleRate} hertz.`
        : `Mic stream failed. ${res.error ?? 'no audio buffers'}`,
    );
  };

  const demoInterrupt = () => {
    sys.queue.say(
      'This is a long answer from the Communicator. It describes the room in detail. There is a sofa on your left. There is a table ahead. A window is on your right.',
    );
    setTimeout(() => sys.queue.alert('Step down ahead.'), 2500);
  };

  // ---------- render ----------
  if (!started) {
    return (
      <View style={[styles.root, styles.center]}>
        <StatusBar style="light" />
        <Text style={styles.title} accessibilityRole="header">Iris</Text>
        <Text style={styles.subtitle}>Your seeing companion. Use with your cane or guide dog.</Text>
        <Pressable
          style={styles.startBtn}
          onPress={startIris}
          accessibilityRole="button"
          accessibilityLabel="Start Iris"
          accessibilityHint="Turns on the camera and microphone"
        >
          <Text style={styles.startText}>Start Iris</Text>
        </Pressable>
        <Text style={styles.small}>Server: {serverUrl}</Text>
      </View>
    );
  }

  const now = Date.now();
  const seen = Object.values(sys.store.lastSeen).sort((a, b) => b.at - a.at).slice(0, 6);
  const live = sys.live;
  const label =
    mode === 'live'
      ? micMuted
        ? 'Listening paused. Tap to resume'
        : live.state === 'ready'
          ? 'Listening. Say "Iris, …"'
          : live.state === 'off'
            ? 'Live off'
            : 'Connecting…'
      : commState === 'listening'
        ? 'Listening… release to ask'
        : commState === 'thinking'
          ? 'Thinking…'
          : 'Hold to ask Iris';
  const q = sys.queue.state;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.cameraWrap}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          animateShutter={false}
          mute
          onCameraReady={() => {
            cameraReady.current = true;
          }}
        />
        <View style={styles.overlay}>
          <Text style={styles.overlayText} numberOfLines={2}>
            {sys.logger.lastScene || 'Looking…'}
          </Text>
          <Text style={styles.overlaySmall}>
            {serverOk === false ? '⚠ server unreachable · ' : ''}
            {sys.perception.lastError ? `⚠ ${sys.perception.lastError.slice(0, 60)}` : `frame ${sys.perceptionMs} ms`}
          </Text>
        </View>
      </View>

      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={[
          styles.talk,
          (commState === 'listening' || (mode === 'live' && !!live.heard)) && styles.talkListening,
          (commState === 'thinking' || (mode === 'live' && live.state !== 'ready')) && styles.talkThinking,
          mode === 'live' && micMuted && styles.talkMuted,
        ]}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={
          mode === 'live'
            ? 'Tap to pause or resume listening'
            : 'Hold while you speak, or tap once to start and tap again to stop'
        }
      >
        <Text style={styles.talkText}>{label}</Text>
        {mode === 'live' && live.heard ? (
          <Text style={styles.speaking} numberOfLines={2}>
            🗣 {live.heard}
          </Text>
        ) : null}
        {q.speaking ? (
          <Text style={styles.speaking} numberOfLines={2}>
            {q.priority === 'alert' ? '⚠ ' : '🔊 '}
            {q.text}
          </Text>
        ) : null}
        {!micOk ? <Text style={styles.speaking}>Microphone permission missing</Text> : null}
      </Pressable>

      <ScrollView style={styles.debug} contentContainerStyle={{ paddingBottom: 40 }}>
        {mode === 'live' ? (
          <>
            <Text style={styles.dim}>
              Live: {live.state} · {live.requireWake ? 'needs "Iris"' : 'answers everything'}
            </Text>
            {live.lastHeard ? <Text style={styles.line}>🗣 {live.lastHeard}</Text> : null}
            {live.lastAnswer ? <Text style={styles.line}>💬 {live.lastAnswer}</Text> : null}
            {live.lastIgnored ? <Text style={styles.dim}>ignored (no "Iris"): {live.lastIgnored}</Text> : null}
          </>
        ) : null}
        {mode === 'ptt' && sys.comm.lastTranscript ? <Text style={styles.line}>🗣 {sys.comm.lastTranscript}</Text> : null}
        {mode === 'ptt' && sys.comm.lastAnswer ? <Text style={styles.line}>💬 {sys.comm.lastAnswer}</Text> : null}
        {sys.guardian.staleDropped ? (
          <Text style={styles.dim}>{sys.guardian.staleDropped} stale hazard frame(s) skipped</Text>
        ) : null}
        <Text style={styles.h}>Guardian alerts</Text>
        {sys.recentAlerts.length === 0 ? <Text style={styles.dim}>none yet</Text> : null}
        {sys.recentAlerts.map((a) => (
          <Text key={a.at + a.text} style={styles.line}>
            ⚠ {a.text} <Text style={styles.dim}>{timeAgo(now - a.at)}</Text>
          </Text>
        ))}
        <Text style={styles.h}>Last seen</Text>
        {seen.length === 0 ? <Text style={styles.dim}>nothing yet</Text> : null}
        {seen.map((s) => (
          <Text key={s.key} style={styles.line}>
            {s.label}: {s.held ? 'in hand' : s.location} <Text style={styles.dim}>{timeAgo(now - s.at)}</Text>
          </Text>
        ))}
        <Text style={styles.h}>Short-term memory</Text>
        <Text style={styles.dim}>{sys.store.shortTerm?.text ?? `${sys.store.events.length} events logged`}</Text>
        {sys.store.learnHabits().length ? <Text style={styles.h}>Habits</Text> : null}
        {sys.store.learnHabits().slice(0, 4).map((h) => (
          <Text key={h.key} style={styles.line}>
            {h.label} → usually {h.place} ({h.count}/{h.total})
          </Text>
        ))}

        <Text style={styles.h}>Demo controls</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={question}
            onChangeText={setQuestion}
            placeholder="Type a question (backup)"
            placeholderTextColor="#777"
            onSubmitEditing={() => {
              void sys.comm.askText(question);
              setQuestion('');
            }}
          />
        </View>
        <View style={styles.row}>
          <SmallBtn
            label={mode === 'live' ? 'Mode: Live (switch to push-to-talk)' : 'Mode: Push-to-talk (switch to Live)'}
            onPress={() => {
              sys.micMuted = false;
              setMicMuted(false);
              setMode((m) => (m === 'live' ? 'ptt' : 'live'));
            }}
          />
          {mode === 'live' ? (
            <SmallBtn
              label={live.requireWake ? 'Wake word: on' : 'Wake word: off'}
              onPress={() => {
                live.requireWake = !live.requireWake;
                setTick((n) => n + 1);
              }}
            />
          ) : null}
          <SmallBtn label="Test interrupt" onPress={demoInterrupt} />
          <SmallBtn label="Mic stream test" onPress={() => void micTest()} />
          <SmallBtn
            label={sys.perception.isRunning ? 'Pause watching' : 'Resume watching'}
            onPress={() => (sys.perception.isRunning ? sys.perception.stop() : sys.perception.start())}
          />
          <SmallBtn label="Summarize now" onPress={() => void sys.stm.tick().then(() => sys.ltm.tick())} />
          <SmallBtn label="Clear memory" onPress={() => sys.store.clear()} />
        </View>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
            accessibilityLabel="Server address"
          />
          <SmallBtn label="Save" onPress={saveUrl} />
        </View>
      </ScrollView>
    </View>
  );
}

function SmallBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.smallBtn} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.smallBtnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', paddingTop: Platform.OS === 'ios' ? 50 : 30 },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#FFD60A', fontSize: 64, fontWeight: '800' },
  subtitle: { color: '#fff', fontSize: 20, textAlign: 'center', marginVertical: 16 },
  startBtn: { backgroundColor: '#FFD60A', paddingVertical: 28, paddingHorizontal: 60, borderRadius: 24, marginTop: 24 },
  startText: { color: '#000', fontSize: 32, fontWeight: '800' },
  small: { color: '#888', marginTop: 24 },
  cameraWrap: { height: '28%', marginHorizontal: 12, borderRadius: 16, overflow: 'hidden', backgroundColor: '#111' },
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 8, backgroundColor: 'rgba(0,0,0,0.6)' },
  overlayText: { color: '#fff', fontSize: 14 },
  overlaySmall: { color: '#aaa', fontSize: 11 },
  talk: {
    flex: 1,
    minHeight: 200,
    margin: 12,
    borderRadius: 24,
    backgroundColor: '#FFD60A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  talkListening: { backgroundColor: '#FF453A' },
  talkThinking: { backgroundColor: '#0A84FF' },
  talkMuted: { backgroundColor: '#555' },
  talkText: { color: '#000', fontSize: 34, fontWeight: '800', textAlign: 'center' },
  speaking: { color: '#000', fontSize: 16, marginTop: 12, textAlign: 'center' },
  debug: { maxHeight: '34%', paddingHorizontal: 14 },
  h: { color: '#FFD60A', fontWeight: '700', marginTop: 10, marginBottom: 2 },
  line: { color: '#eee', fontSize: 13, marginVertical: 1 },
  dim: { color: '#888', fontSize: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 },
  input: { flex: 1, minWidth: 160, color: '#fff', borderColor: '#444', borderWidth: 1, borderRadius: 8, padding: 8 },
  smallBtn: { backgroundColor: '#222', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8 },
  smallBtnText: { color: '#fff', fontSize: 12 },
});
