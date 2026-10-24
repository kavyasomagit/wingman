# Iris: Requirements (v1 hackathon POC)

Iris is a wearable AI companion for blind and low-vision people. The phone hangs on a lanyard or chest clip with the rear camera facing outward. Iris supplements a cane or guide dog. It never replaces them.

## Scope

v1 runs in Expo Go: periodic camera snapshots and push-to-talk questions. Real-time streaming (Gemini Live API) and on-device hazard detection are out of scope for v1 (see "Future").

## Primary demo flow (must work end to end)

1. User opens Iris. Camera, microphone, and keep-awake start. Iris says "Iris is watching."
2. User walks around and picks up / puts down their keys. The Scene Logger records it.
3. An obstacle or step comes into view. The Guardian speaks a short warning and vibrates without being asked.
4. User holds the talk button and asks "where did I leave my keys?"
5. Iris answers from memory: "Your keys were on the kitchen counter next to the red mug. I saw them 4 minutes ago."
6. User asks "what's in front of me?" or "read this sign". Iris answers from the live frame.

## Requirements

### R1 Perception loop
- R1.1 WHILE the app is active, Iris SHALL capture a downscaled camera frame every few seconds (default 4 s) and never run two analyses at once.
- R1.2 The screen SHALL stay awake while Iris is active.
- R1.3 Frames SHALL go to the backend proxy. The app SHALL NOT contain the Gemini API key.

### R2 Scene Logger
- R2.1 For each analysed frame, the Scene Logger SHALL append timestamped events for meaningful changes, especially objects in the user's hands or objects the user interacts with.
- R2.2 The Scene Logger SHALL keep a "last seen" index: object name, location description, nearby objects, timestamp, held-by-user flag.
- R2.3 WHEN an object is seen again, its index entry SHALL be replaced by the newer sighting.

### R3 Short-Term Memory
- R3.1 Iris SHALL keep a rolling summary of recent events (the past few hours), refreshed periodically from the event log.

### R4 Long-Term Memory
- R4.1 Iris SHALL keep a diary-style summary that grows over time.
- R4.2 Iris SHALL learn habits from sighting history (for example "keys are usually on the hook by the door") by counting where each object is most often seen.
- R4.3 Memory SHALL persist across app restarts on the device.

### R5 Communicator
- R5.1 The Communicator SHALL speak only in response to a user question.
- R5.2 WHEN the user holds the talk button, Iris SHALL record audio. WHEN released, Iris SHALL send the audio, a fresh frame, and memory context to the backend and speak the answer.
- R5.3 WHEN the question is "where is X", Iris SHALL answer from the most recent sighting of X, including how long ago it was seen. IF X was never seen, Iris SHALL say so and MAY mention a learned habit.
- R5.4 Iris SHALL be able to describe the scene and read visible text from the live frame.

### R6 Guardian
- R6.1 The Guardian SHALL warn about immediate hazards (steps, drop-offs, obstacles at head/body height, moving vehicles or bikes, wet floor, open doors) without being asked.
- R6.2 Warnings SHALL be short (under ~8 words), directional ("Step down ahead"), with a haptic pulse.
- R6.3 The same hazard type SHALL NOT be repeated within a cooldown (default 15 s). A more urgent level of the same hazard MAY bypass the cooldown.

### R7 Priority audio queue
- R7.1 All speech SHALL go through one queue.
- R7.2 A Guardian alert SHALL interrupt any Communicator speech immediately.
- R7.3 After the alert, the interrupted Communicator answer SHALL resume from the interrupted sentence.
- R7.4 Alerts SHALL be spoken before any queued Communicator speech.

### R8 Safety language
- R8.1 Iris SHALL NEVER state that something is safe (for example "safe to cross"). Prompts forbid it and the app filters spoken text as a last line of defence.
- R8.2 Iris SHALL remind the user to rely on their cane, guide dog, or traffic signals when asked about crossing.

### R9 Backend proxy
- R9.1 A small Node server SHALL hold the Gemini API key in an environment variable and expose only Iris-specific endpoints.
- R9.2 The server SHALL accept an optional shared token so the proxy is not an open relay.

### R10 Tests
- R10.1 Automated tests SHALL cover: hazards always interrupt other speech; alerts are not repeated within the cooldown; "where is X" returns the most recent sighting.

## Future (v2, not in this build)
- Expo development build with Gemini Live API streaming audio and video.
- On-device hazard detection (for example a small object detector) for sub-second warnings.
- Wake word instead of push-to-talk.
