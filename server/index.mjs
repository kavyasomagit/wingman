// Iris backend proxy: keeps the Gemini API key off the phone (R9).
// Node 22+, no dependencies. Run: GEMINI_API_KEY=... node index.mjs
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
// Minimal .env loader (server/.env), so the key never needs to be typed on the command line.
const envFile = path.join(here, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const FAST_MODEL = process.env.GEMINI_FAST_MODEL || MODEL;
const TOKEN = process.env.IRIS_TOKEN || '';
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 8 * 1024 * 1024;

if (!KEY) {
  console.error('Missing GEMINI_API_KEY (set it in server/.env or the environment).');
  process.exit(1);
}

const SAFETY_RULES = `SAFETY RULES (never break these):
- Never say that anything is "safe", "clear", or "safe to cross". You cannot guarantee safety.
- For street crossings, describe what you see, then tell the user to rely on their cane, guide dog, traffic signals, or ask a person.
- Iris supports a cane or guide dog. It never replaces them.`;

// ---------- Gemini ----------
function thinkingConfigFor(model) {
  if (process.env.GEMINI_THINKING === 'off') return undefined;
  if (process.env.GEMINI_THINKING_LEVEL) return { thinkingLevel: process.env.GEMINI_THINKING_LEVEL };
  if (/2\.5-flash/.test(model)) return { thinkingBudget: 0 }; // lowest latency
  if (/gemini-3.*lite/.test(model)) return { thinkingLevel: 'minimal' };
  if (/gemini-3/.test(model)) return { thinkingLevel: 'low' };
  return undefined;
}

// Fallback chain: the first model that differs from the one that just failed.
const FALLBACKS = [process.env.GEMINI_FALLBACK_MODEL, 'gemini-3.1-flash-lite', 'gemini-3.5-flash'].filter(Boolean);

// Try the primary model; on overload (503/429/5xx) or timeout, retry once on the fallback model.
async function gemini(opts) {
  try {
    return await geminiOnce(opts);
  } catch (e) {
    const retryable = e.name === 'TimeoutError' || e.name === 'AbortError' || [429, 500, 502, 503, 504].includes(e.upstream);
    const fallback = FALLBACKS.find((m) => m !== opts.model);
    if (!retryable || !fallback) throw e;
    console.warn(`  ${opts.model} failed (${e.upstream ?? e.name}); falling back to ${fallback}`);
    return geminiOnce({ ...opts, model: fallback, timeoutMs: opts.fallbackTimeoutMs ?? opts.timeoutMs });
  }
}

async function geminiOnce({ model, system, parts, schema, temperature = 0.2, timeoutMs = 20_000 }) {
  const generationConfig = { responseMimeType: 'application/json', responseSchema: schema, temperature };
  const tc = thinkingConfigFor(model);
  if (tc) generationConfig.thinkingConfig = tc;
  const started = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    const err = new Error(`Gemini ${res.status}: ${msg}`);
    err.status = res.status === 429 ? 429 : 502;
    err.upstream = res.status;
    throw err;
  }
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  try {
    const json = JSON.parse(text);
    console.log(`  ${model} ${Date.now() - started}ms`);
    return json;
  } catch {
    const err = new Error('Gemini returned non-JSON output');
    err.status = 502;
    throw err;
  }
}

const S = (type, extra = {}) => ({ type, ...extra });

// ---------- /api/perceive: one frame -> Guardian hazards + Scene Logger data ----------
const PERCEIVE_SYSTEM = `You are the eyes of Iris, a companion for a blind or low-vision person.
The image comes from a phone worn on the user's chest, camera facing forward, so the image shows what is directly in front of them.
Return JSON with:
1) "hazards": ONLY immediate physical hazards IN the user's walking path (straight ahead, roughly the middle third of the image) within about 3 meters:
   stairs or steps (up/down), curbs, drop-offs, obstacles at head/body/foot height, open doors or cabinet doors, wet floor, poles, low branches,
   moving vehicles, bicycles or scooters approaching, people about to collide. If nothing urgent, return an empty array. Do not invent hazards.
   - Do NOT report furniture, appliances, walls, or counters that are beside the path (left/right) or that the user is simply standing next to.
     A table, chair, or refrigerator only counts if it is directly ahead and close enough to bump into.
   - Most frames have no hazards. When in doubt, leave it out.
   - If the image is dark, black, covered, or too blurry to judge, return NO hazards (this is a camera problem, not a hazard).
   - type: short stable snake_case category, e.g. "stairs_down", "obstacle_ahead", "vehicle", "open_door".
   - urgency: "high" (imminent, within ~1-2 m or moving toward user), "medium" (ahead, a few meters), "low".
   - message: at most 8 words, directional, spoken aloud. e.g. "Step down ahead.", "Chair on your left.", "Bike approaching from right."
2) "objects": notable portable objects a person might later look for (keys, phone, wallet, glasses, mug, bag, remote, medication, bottle, book, headphones, etc.).
   - name: plain name, e.g. "keys", "red mug".
   - location: prepositional phrase a blind person can use, e.g. "on the kitchen counter, left of the sink".
   - place: short canonical place, e.g. "kitchen counter", "coffee table", "hook by the door".
   - near: up to 2 nearby landmark objects.
   - held: true if the object is in the user's hand(s).
3) "events": 0-3 short past-tense log lines about meaningful things, especially what the user is holding, picking up, putting down, or interacting with.
   e.g. "User put keys on the kitchen counter next to a red mug." Skip if nothing notable.
4) "scene": one short sentence describing the scene (room/place and main things).
${SAFETY_RULES}`;

const PERCEIVE_SCHEMA = S('OBJECT', {
  properties: {
    hazards: S('ARRAY', {
      items: S('OBJECT', {
        properties: {
          type: S('STRING'),
          urgency: S('STRING', { enum: ['high', 'medium', 'low'] }),
          message: S('STRING'),
        },
        required: ['type', 'urgency', 'message'],
      }),
    }),
    objects: S('ARRAY', {
      items: S('OBJECT', {
        properties: {
          name: S('STRING'),
          location: S('STRING'),
          place: S('STRING'),
          near: S('ARRAY', { items: S('STRING') }),
          held: S('BOOLEAN'),
        },
        required: ['name', 'location', 'place', 'held'],
      }),
    }),
    events: S('ARRAY', { items: S('STRING') }),
    scene: S('STRING'),
  },
  required: ['hazards', 'objects', 'events', 'scene'],
});

// Backstop for the prompt rules: drop camera-condition "hazards" and side-of-path furniture.
const NOT_A_HAZARD =
  /\b(camera|lens)\b|\b(image|view|frame|picture|screen) (is |looks |appears )?(completely |very |too |mostly )?(dark|black|blurr?y|blurred|obstructed|covered)\b|\bno details\b|\b(cannot|can't|unable to) see\b|\btotal darkness\b/i;
const SIDE = /\b(on|to) (your|the) (left|right)\b|\bbeside you\b|\bnext to you\b/i;
const STATIC_THING = /\b(refrigerator|fridge|table|desk|counter|wall|sofa|couch|shelf|microwave|sink|dishwasher|chair|appliance)s?\b/i;
export function filterHazards(hazards = []) {
  return hazards.filter((h) => {
    const text = `${h?.type ?? ''} ${h?.message ?? ''}`;
    if (!h?.message || NOT_A_HAZARD.test(text)) return false;
    // Furniture/appliances off to the side are not in the walking path (unless the model marked it high urgency).
    if (STATIC_THING.test(text) && SIDE.test(text) && h.urgency !== 'high') return false;
    return true;
  });
}

async function perceive({ image }) {
  if (!isB64(image)) throw badRequest('image (base64 JPEG) is required');
  const out = await gemini({
    model: FAST_MODEL,
    system: PERCEIVE_SYSTEM,
    parts: [{ inlineData: { mimeType: 'image/jpeg', data: image } }, { text: 'Analyse this frame.' }],
    schema: PERCEIVE_SCHEMA,
    temperature: 0.1,
    // A frame older than a few seconds is useless for hazards: fail fast, then one quick fallback try.
    timeoutMs: 6_000,
    fallbackTimeoutMs: 4_000,
  });
  out.hazards = filterHazards(out.hazards);
  const hz = (out.hazards ?? []).map((h) => `${h.urgency}:${h.message}`).join(' | ');
  const obj = (out.objects ?? []).map((o) => `${o.name}${o.held ? '(held)' : ''}@${o.place}`).join(', ');
  console.log(`  scene: ${out.scene ?? ''}${hz ? `\n  hazards: ${hz}` : ''}${obj ? `\n  objects: ${obj}` : ''}`);
  return out;
}

// ---------- /api/ask: Communicator ----------
const ASK_SYSTEM = `You are Iris, a warm, concise voice companion for a blind or low-vision person.
You receive: the user's spoken question (audio) or typed question, the live camera image (what is in front of them right now), and Iris's memory.
Answer for speech: 1-3 short sentences, no markdown, no lists, no emojis. Use clock-face or left/right/ahead directions.
- "what's in front of me": describe the live image, most important things first.
- "read this": read the visible text exactly, then briefly say what it is.
- "where is X / where did I leave X": answer from memory (LAST SEEN, RECENT EVENTS, HABITS). Say where and how long ago. If X is visible right now in the image, say so.
  If not in memory, say you haven't seen it and mention a habit if one exists.
- Questions about the past ("what did I do", "did I take my pills"): use memory.
Also return:
- transcript: what the user asked (verbatim as best you can).
- intent: one of "where_is", "describe", "read_text", "memory", "other".
- object: for where_is, the object name as it appears in LAST SEEN if it matches (e.g. "keys"), else the user's word. Empty otherwise.
${SAFETY_RULES}`;

const ASK_SCHEMA = S('OBJECT', {
  properties: {
    transcript: S('STRING'),
    intent: S('STRING', { enum: ['where_is', 'describe', 'read_text', 'memory', 'other'] }),
    object: S('STRING'),
    answer: S('STRING'),
  },
  required: ['transcript', 'intent', 'object', 'answer'],
});

async function ask({ audio, audioMime, question, image, memory }) {
  if (!isB64(audio) && !(typeof question === 'string' && question.trim())) throw badRequest('audio or question is required');
  const parts = [];
  if (isB64(image)) parts.push({ text: 'LIVE CAMERA IMAGE:' }, { inlineData: { mimeType: 'image/jpeg', data: image } });
  parts.push({ text: `IRIS MEMORY (current time: ${new Date().toLocaleTimeString()}):\n${String(memory || 'No memories yet.').slice(0, 20000)}` });
  if (isB64(audio)) {
    parts.push({ text: "USER'S SPOKEN QUESTION:" }, { inlineData: { mimeType: safeAudioMime(audioMime), data: audio } });
  } else {
    parts.push({ text: `USER'S QUESTION: ${String(question).slice(0, 500)}` });
  }
  const out = await gemini({ model: MODEL, system: ASK_SYSTEM, parts, schema: ASK_SCHEMA, temperature: 0.3, timeoutMs: 12_000, fallbackTimeoutMs: 10_000 });
  console.log(`  heard: ${out.transcript} [${out.intent}${out.object ? ':' + out.object : ''}]\n  answer: ${out.answer}`);
  return out;
}

// ---------- /api/summarize: Short-Term and Long-Term Memory ----------
const SUMMARY_SCHEMA = S('OBJECT', { properties: { summary: S('STRING') }, required: ['summary'] });

async function summarize({ kind, events, previous }) {
  if (typeof events !== 'string' || !events.trim()) throw badRequest('events text is required');
  const system =
    kind === 'diary'
      ? `You write Iris's long-term diary for a blind user. Write a short diary entry (2-4 sentences, past tense, second person "you") of what happened in these events: places, activities, where important objects were left. Note any patterns or habits.`
      : `You maintain Iris's short-term memory for a blind user. Merge the previous summary and the new timestamped events into one detailed rolling summary of the last few hours (max ~150 words). Keep where objects were last put, what the user did, and times. Drop trivial repeats.`;
  return gemini({
    model: FAST_MODEL,
    system,
    parts: [{ text: `PREVIOUS SUMMARY:\n${String(previous || '(none)').slice(0, 4000)}\n\nEVENTS:\n${events.slice(0, 20000)}` }],
    schema: SUMMARY_SCHEMA,
  });
}

// ---------- HTTP ----------
function isB64(s) {
  return typeof s === 'string' && s.length > 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(s.slice(0, 200));
}
function safeAudioMime(m) {
  const allowed = ['audio/mp4', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/3gpp', 'audio/flac'];
  return allowed.includes(m) ? m : 'audio/mp4';
}
function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(badRequest('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Device diagnostics: the phone posts test results here so they show up in the server log.
async function diag(body) {
  console.log('[diag]', JSON.stringify(body).slice(0, 2000));
  return { ok: true };
}

const routes = { '/api/perceive': perceive, '/api/ask': ask, '/api/summarize': summarize, '/api/diag': diag };

// ---------- /live: WebSocket relay between the phone and the Gemini Live API ----------
// Phone -> server: binary frames = 16 kHz mono int16 PCM mic audio; JSON text frames:
//   {type:'start', memory} | {type:'frame', data: base64 jpeg} | {type:'memory', memory}
// Server -> phone (JSON): ready | heard{text} | text{text} | turn_complete | interrupted | status{state} | error{message}
// Gemini's audio output is dropped; the phone speaks the transcript through its priority queue.
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;

const LIVE_SYSTEM = (memory) => `You are Iris, a warm, concise voice companion for a blind or low-vision person.
The user wears a phone on their chest; you receive their voice and periodic camera frames. The latest frame shows what is in front of them right now.
Rules:
- Answer in 1-2 short sentences. Plain speech, no lists. Use left/right/ahead or clock-face directions.
- "What's in front of me": describe the latest frame, most important things first.
- "Read this": read the visible text exactly.
- "Where is X / where did I leave X": answer from MEMORY below, say where and how long ago. If X is visible in the latest frame, say so.
- The user may start with "Iris". Ignore background conversation that is not addressed to you.
- Do not describe frames unless asked. Do not mention that you are receiving images.
${SAFETY_RULES}

MEMORY (captured at ${new Date().toLocaleTimeString()}):
${String(memory || 'No memories yet.').slice(0, 15000)}`;

function attachLive(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/live', maxPayload: 4 * 1024 * 1024 });
  wss.on('connection', (client, req) => {
    const url = new URL(req.url, 'http://x');
    if (TOKEN && url.searchParams.get('token') !== TOKEN) return client.close(4401, 'Unauthorized');
    const toClient = (obj) => client.readyState === 1 && client.send(JSON.stringify(obj));
    let memory = '';
    let memoryDirty = false;
    let up = null;
    let upReady = false;
    let closed = false;
    let sessionAt = 0;
    let lastHeardAt = 0;
    let inTurn = false;
    let failures = 0;
    console.log('[live] phone connected');

    const reopen = (why) => {
      console.log(`[live] refreshing session (${why})`);
      if (up) {
        up.onclose = null;
        try { up.close(); } catch {}
      }
      openUp();
    };

    function openUp() {
      upReady = false;
      sessionAt = Date.now();
      memoryDirty = false;
      const ws = new WebSocket(LIVE_URL);
      up = ws;
      ws.onopen = () =>
        ws.send(JSON.stringify({
          setup: {
            model: `models/${LIVE_MODEL}`,
            generationConfig: { responseModalities: ['AUDIO'] },
            systemInstruction: { parts: [{ text: LIVE_SYSTEM(memory) }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
          },
        }));
      ws.onmessage = async (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString('utf8');
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.setupComplete) {
          upReady = true;
          failures = 0;
          console.log(`[live] ${LIVE_MODEL} session ready in ${Date.now() - sessionAt}ms`);
          return toClient({ type: 'ready' });
        }
        if (m.goAway) return reopen('goAway');
        const sc = m.serverContent;
        if (!sc) return;
        if (sc.inputTranscription?.text) {
          inTurn = true;
          lastHeardAt = Date.now();
          toClient({ type: 'heard', text: sc.inputTranscription.text });
        }
        if (sc.outputTranscription?.text) toClient({ type: 'text', text: sc.outputTranscription.text });
        if (sc.interrupted) toClient({ type: 'interrupted' });
        if (sc.turnComplete) {
          inTurn = false;
          toClient({ type: 'turn_complete' });
          if (memoryDirty && Date.now() - sessionAt > 20_000) reopen('memory updated');
        }
      };
      ws.onclose = (e) => {
        if (up !== ws) return;
        upReady = false;
        if (closed) return;
        failures++;
        console.warn(`[live] upstream closed ${e.code} ${String(e.reason).slice(0, 160)}`);
        toClient({ type: 'status', state: 'reconnecting', reason: String(e.reason).slice(0, 160) });
        setTimeout(() => !closed && openUp(), Math.min(5000, 500 * failures));
      };
      ws.onerror = () => {};
    }

    client.on('message', (data, isBinary) => {
      if (isBinary) {
        if (upReady && up?.readyState === 1)
          up.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'start') {
        memory = String(msg.memory || '');
        if (!up) openUp();
      } else if (msg.type === 'frame' && typeof msg.data === 'string') {
        if (upReady && up?.readyState === 1)
          up.send(JSON.stringify({ realtimeInput: { video: { data: msg.data, mimeType: 'image/jpeg' } } }));
      } else if (msg.type === 'memory') {
        const next = String(msg.memory || '');
        if (next !== memory) {
          memory = next;
          memoryDirty = true;
          // Refresh between conversations so answers use fresh memory; never mid-turn.
          if (!inTurn && Date.now() - lastHeardAt > 8_000 && Date.now() - sessionAt > 45_000) reopen('memory updated (idle)');
        }
      }
    });
    client.on('close', () => {
      closed = true;
      console.log('[live] phone disconnected');
      try { up?.close(); } catch {}
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, model: MODEL, fastModel: FAST_MODEL });
  const handler = routes[url.pathname];
  if (req.method !== 'POST' || !handler) return send(res, 404, { error: 'Not found' });
  if (TOKEN && req.headers['x-iris-token'] !== TOKEN) return send(res, 401, { error: 'Unauthorized' });
  const t0 = Date.now();
  try {
    const body = await readJson(req);
    const out = await handler(body);
    console.log(`${url.pathname} 200 ${Date.now() - t0}ms`);
    send(res, 200, out);
  } catch (e) {
    console.error(`${url.pathname} ${e.status || 500} ${e.message}`);
    send(res, e.status || 500, { error: e.status && e.status < 500 ? e.message : 'Upstream error' });
  }
});

attachLive(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Iris proxy on :${PORT}  model=${MODEL} fast=${FAST_MODEL} token=${TOKEN ? 'on' : 'off'}`);
});
