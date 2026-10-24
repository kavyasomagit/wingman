# Iris: Design (v1)

## Overview

```
 Phone (Expo Go)                                         Laptop / server
 ┌────────────────────────────────────────────┐          ┌──────────────────────┐
 │ CameraView ──frame every 4s──► Perception ─┼─HTTP────►│ POST /api/perceive   │
 │                                   │        │          │ POST /api/ask        │
 │            ┌──────────────────────┴───┐    │          │ POST /api/summarize  │
 │            ▼                          ▼    │          │  (holds GEMINI key)  │
 │        Guardian                 Scene Logger          └──────────┬───────────┘
 │            │                          │    │                     ▼
 │            │        ┌─────────────────▼──┐ │              Gemini API
 │            │        │   MemoryStore      │ │
 │            │        │ events, lastSeen,  │◄┼── Short-Term Memory (timer)
 │            │        │ STM, diary, habits │◄┼── Long-Term Memory (timer)
 │            │        └─────────▲──────────┘ │
 │            │                  │ reads      │
 │            │            Communicator ◄─────┼── push-to-talk (expo-audio)
 │            ▼                  ▼            │
 │      SpeechQueue (priority, interrupt/resume) ──► expo-speech + expo-haptics
 └────────────────────────────────────────────┘
```

Agents do not call each other. They read and write the shared `MemoryStore` and push speech into the shared `SpeechQueue`.

## Key decision: one vision call per frame

Guardian and Scene Logger both need each frame. Two Gemini calls per frame would double latency and quota (free tiers allow roughly 10-15 requests per minute). v1 sends each frame once to `/api/perceive`, which returns `{ hazards, objects, events }` in one structured JSON response. The `Perception` service fans the result out to the Guardian and the Scene Logger, which stay separate agents with separate logic. v2 can split them again when hazard detection moves on-device.

## Components

### Core (pure TypeScript, unit tested, no React Native imports)
- `core/speechQueue.ts`: `SpeechQueue` with an injected `Speaker` (`speak(text, onDone)`, `stop()`). Items have priority `alert` or `normal`. Normal answers are split into sentences. When an alert arrives while a normal item is speaking, the queue stops the speaker, keeps the remaining sentences (starting at the interrupted one), speaks all alerts, then resumes. A token per utterance ignores stale `onDone` callbacks fired by `stop()`.
- `core/cooldown.ts`: `AlertCooldown(cooldownMs, clock)`. `shouldAlert(key, level)` returns false while the same key is within cooldown, unless the new level is higher than the last alerted level.
- `core/memory.ts`: `MemoryStore` with event log (capped), `lastSeen` map, sighting history (for habits), STM summary, diary entries. `recordSighting` keeps the newer sighting only. `whereIs(query)` normalises names (lowercase, strips articles and plural "s"/"es", matches exact then substring) and returns the most recent match. `learnHabits()` returns the most frequent location per object with at least 2 sightings. `snapshot()` / `load()` for AsyncStorage persistence. `contextForPrompt()` builds a compact text block with "N minutes ago" values.
- `core/safety.ts`: `sanitizeSpeech(text)` rewrites claims such as "safe to cross", "it is safe", "all clear" into neutral wording.
- `core/format.ts`: `timeAgo(ms)`, `formatWhereAnswer(sighting, now)`.

### Agents (`src/agents`)
- `Perception`: owns the capture loop. `capture()` comes from the camera component, it is a no-op while a request is in flight.
- `Guardian`: for each hazard with urgency `high|medium`, checks cooldown, then `queue.alert(message)` and haptics (`Error` for high, `Warning` for medium).
- `SceneLogger`: writes events and sightings into memory.
- `ShortTermMemory`: every 60 s, if new events exist, calls `/api/summarize` (kind `short`) and stores the summary.
- `LongTermMemory`: every 5 min, calls `/api/summarize` (kind `diary`) and appends a diary entry; habits come from `learnHabits()` locally (deterministic, no API call).
- `Communicator`: on release of the talk button, captures a fresh frame, sends audio + frame + `contextForPrompt()` to `/api/ask`. Response: `{ transcript, intent, object, answer }`. If `intent === "where_is"` and `whereIs(object)` finds a sighting, Iris speaks the deterministic `formatWhereAnswer` (exact timestamps). Otherwise it speaks Gemini's answer. All text passes `sanitizeSpeech`.

### UI (`App.tsx`)
One full-screen screen: camera preview at the top, a very large hold-to-talk button covering most of the screen, a status line, and a small debug panel (last hazards, last-seen list) for the demo audience. Accessibility labels on all controls.

### Backend (`server/`)
Plain Node 22 `http` server, no framework. `fetch` to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `responseMimeType: application/json` and a `responseSchema`. Env: `GEMINI_API_KEY` (required), `GEMINI_MODEL` (default `gemini-2.5-flash`), `GEMINI_FAST_MODEL` for `/api/perceive` (defaults to `GEMINI_MODEL`), `IRIS_TOKEN` (optional, checked against header `x-iris-token`), `PORT` (default 8787). Body limit 8 MB.

Prompts: all include the rule "Never say anything is safe. Never say 'safe to cross'. Remind the user to use their cane, guide dog, or signals."

## Error handling
- Network or model errors in perception: log, skip the frame, keep looping.
- Ask errors: speak "Sorry, I couldn't reach Iris's brain. Please try again."
- Malformed JSON from Gemini: server returns 502, app treats it as an error.

## Testing
Vitest on `src/core`: speech queue interrupt/resume/ordering, cooldown, whereIs most-recent, safety filter. Server smoke script (`npm run smoke`) once the API key is provided.

## Demo network setup
Phone and laptop on the same Wi-Fi; app uses `EXPO_PUBLIC_IRIS_API_URL=http://<laptop LAN IP>:8787`. If the venue Wi-Fi isolates clients, use a tunnel (for example `npx localtunnel --port 8787`) or a phone hotspot.
