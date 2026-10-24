# Iris: a seeing companion that remembers

**Track:** Healthcare & Biotech

## Short version (for a summary field)

Iris is an AI companion for blind and low-vision people. The phone is worn on a lanyard or chest clip with the camera facing out. Iris watches and listens, warns about hazards like steps and obstacles without being asked, and remembers what it has seen. So when you ask "Iris, where are my keys?", it can answer "Your keys were on the kitchen counter, near the red mug. I saw them 4 minutes ago." It works hands-free, supports a cane or guide dog without replacing them, and never tells the user that anything is "safe".

## The problem

The World Health Organization estimates that at least 2.2 billion people have a near or distance vision impairment. Two everyday problems come up again and again:

- **Finding things.** Keys, phone, glasses, medication. Asking a sighted person for help isn't always possible.
- **Unexpected hazards.** A step, an open door, or a chair left in a walkway.

Current AI vision assistants answer questions about what the camera sees at that moment. They don't remember what they saw a few minutes ago, and they only speak when asked, even if there's a step right ahead.

## What Iris does

**Remembers what it has seen**
- Logs meaningful events with timestamps, especially objects the user picks up, puts down, or holds.
- Keeps a "last seen" index of objects with the location, nearby landmarks, and time. Example: keys, on the kitchen counter, near the red mug, 4 minutes ago.
- "Where is X?" questions return the most recent sighting with the exact time since it was seen. Name variants like "my keys", "key", and "car keys" all match.
- Builds a rolling short-term summary of recent hours and a diary-style long-term memory.
- Learns habits from repeated sightings, for example "your keys are usually on the hook by the door".
- Memory persists on the device across app restarts.

**Warns about hazards, unprompted**
- Watches the camera continuously for steps, curbs, drop-offs, obstacles at head or body height, open doors, wet floors, and approaching bikes or vehicles.
- Speaks short, directional warnings ("Step down ahead.", "Chair directly ahead.") with a vibration pattern that reflects urgency.
- Doesn't repeat the same warning within 15 seconds, unless the hazard becomes more urgent.
- Only warns about things in the walking path, not furniture off to the side. Drops warnings from camera frames that arrived too late to be useful, since the user has likely moved past.

**Answers questions hands-free**
- Just say "Iris, …". There's no button to find. A wake word keeps Iris from responding to nearby conversations.
- "What's in front of me?" describes the scene, most important things first.
- "Read this" reads signs, labels, and other visible text.
- Answers start speaking within about a second of the user finishing the question, sentence by sentence.
- Push-to-talk and typed questions are available as fallbacks.

**Safety by design**
- Iris supplements a cane or guide dog and never replaces them.
- It never says anything is "safe" or "safe to cross". The prompts forbid it, and a final filter on every spoken sentence replaces such claims with a reminder to rely on the cane, guide dog, or crossing signals.
- Hazard alerts always take priority. If Iris is in the middle of an answer, the alert interrupts it immediately, then the answer resumes from the interrupted sentence.

## How it works

Iris is a multi-agent system. Five agents run in parallel and never call each other. They coordinate only through a shared memory store and a single priority speech queue.

| Agent | Role |
|---|---|
| **Scene Logger** | Writes timestamped events and the last-seen object index from each camera frame. |
| **Guardian** | Checks each frame for urgent hazards and pushes priority alerts, with cooldowns. |
| **Short-Term Memory** | Every minute, merges new events into a rolling summary. |
| **Long-Term Memory** | Writes diary entries over time and learns habits from sighting history. |
| **Communicator** | Speaks only when asked. Uses live audio, the latest frame, and all memory layers. |

- **One vision call per frame.** Each camera frame is analysed once, and the result goes to both the Guardian and the Scene Logger. This halves API usage compared with a separate call per agent.
- **Priority speech queue.** All speech goes through one queue. Alerts jump ahead and interrupt answers, and interrupted answers resume where they stopped.
- **Real-time voice.** Microphone audio streams at 16 kHz to a Gemini Live API session. The answer comes back as text and goes through the same speech queue, so hazard alerts still interrupt it.
- **Echo guard.** While Iris is speaking, the microphone sends silence, so Iris doesn't hear and answer its own voice.
- **Key security.** The Gemini API key never reaches the device. On the phone, a small Node server relays requests. On the web, single-use Live API tokens are issued by a serverless function.
- **Reliability.** If a model is overloaded or slow, requests automatically retry on a different model.

## Built with

- **Phone app:** React Native with Expo. Uses expo-camera, expo-audio (including real-time microphone streaming), expo-speech, expo-haptics, and expo-keep-awake. Tested on a real Android phone through Expo Go.
- **Web version:** React + Vite on Vercel. Uses browser camera and microphone, AudioWorklet audio streaming, Web Speech, vibration, and Wake Lock.
- **AI:** Gemini vision models for scene and hazard analysis and summaries; the Gemini Live API for hands-free voice.
- **Backend:** a dependency-light Node proxy (phone) and Vercel serverless functions (web).
- **Tests:** 24 automated tests covering the core rules:
  - Hazards always interrupt other speech, and interrupted answers resume correctly.
  - Alerts aren't repeated within the cooldown.
  - "Where is X?" returns the most recent sighting.
  - The safety-language filter.
  - Hands-free wake-word gating.
- **Developed with Kiro:** spec-driven development, starting from requirements, then design, then tasks (see `.kiro/specs/iris/`).

## Accessibility

- One very large, high-contrast (yellow on black) touch target. In hands-free mode, it pauses and resumes listening.
- Screen-reader labels on all controls. Tap-to-start / tap-to-stop works with screen readers, as an alternative to press-and-hold.
- Vibration patterns for alerts, so warnings come through even in noisy places.
- Designed for the phone to be worn, not held, leaving the user's hands free for a cane or guide dog harness.

## Privacy

Camera frames are analysed and then discarded. They aren't stored. Iris's memory is a text log of objects and events, kept only on the user's device (or in the browser for the web version).

## Current limits and what's next

- **Hazard latency.** Warnings currently arrive about 1–3 seconds after the frame is captured, because analysis happens in the cloud. Next step: on-device hazard detection for sub-second warnings.
- **Wake word in noisy rooms.** It can mishear "Iris" in loud places; a toggle turns the wake word off.
- **Planned:**
  - Bone-conduction headphone support so the user's ears stay open.
  - Offline mode.
  - Shared memory across a user's devices.
  - Opt-in caregiver check-ins.

## Try it

- **Web:** `<VERCEL URL>/?code=<ACCESS CODE>`. Allow camera and microphone, turn the sound on, and tap **Start Iris**.
  1. Show an object such as keys or a mug, then put it down and point the camera elsewhere.
  2. Say "Iris, where are my keys?"
  3. Point the camera at a chair or step a short distance ahead to hear an unprompted warning.
  4. Tap **Test interrupt** to hear a hazard alert cut into an answer and the answer resume.
- **Phone app and source:** https://github.com/kavyasomagit/wingman. Setup steps are in the README.
