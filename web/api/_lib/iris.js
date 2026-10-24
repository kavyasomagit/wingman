// Shared Iris Gemini logic for Vercel functions (ported from server/index.mjs).
// Files under api/_lib are not exposed as routes.
export const KEY = process.env.GEMINI_API_KEY;
export const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
export const FAST_MODEL = process.env.GEMINI_FAST_MODEL || "gemini-3.1-flash-lite";
export const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
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
function filterHazards(hazards = []) {
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


export { gemini, perceive, ask, summarize, filterHazards, LIVE_SYSTEM, badRequest };
