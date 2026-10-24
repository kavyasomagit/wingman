# Iris: Tasks

## Phase 1: v1 plan (ordered for a 2-hour build)

- [x] 1. Scaffold Expo app (`app/`) and install expo-camera, expo-audio, expo-speech, expo-haptics, expo-keep-awake, expo-file-system, expo-image-manipulator, AsyncStorage, vitest. (R1)
- [x] 2. Core logic with tests (R7, R6.3, R2.3, R5.3, R8, R10)
  - [x] 2.1 `SpeechQueue` with interrupt and resume
  - [x] 2.2 `AlertCooldown`
  - [x] 2.3 `MemoryStore` (events, lastSeen, whereIs, habits, persistence snapshot)
  - [x] 2.4 `sanitizeSpeech`, `timeAgo`, `formatWhereAnswer`, `resolveAnswer`
  - [x] 2.5 Vitest suites for the three core rules plus safety filter
- [x] 3. Backend proxy `server/` with `/api/perceive`, `/api/ask`, `/api/summarize`, `/health`, token check, smoke script. (R9)
- [x] 4. Agents: Perception, Guardian, SceneLogger, ShortTermMemory, LongTermMemory, Communicator. (R1-R6)
- [x] 5. App UI: camera, hold-to-talk, keep-awake, status, debug panel, permissions. (R1, R5)
- [x] 6. Typecheck, run tests, smoke-test the server with the real Gemini key.
  - Finding: `gemini-2.5-flash` is retired for new keys. Benchmarked the available models; chose `gemini-3.5-flash` for questions and a flash-lite model for frames.
- [x] 7. Demo on phone via Expo Go; README with run steps and demo script.

## Phase 2: changes driven by live testing (spec updated as assumptions changed)

- [x] 8. Reliability, from server-log analysis of the first phone run (R1.1, R6)
  - [x] 8.1 Fallback model on 503/429/timeout; the fallback must differ from the primary
  - [x] 8.2 Frame timeout 30 s → 6 s (+4 s fallback). Guardian drops hazards from frames older than 6 s
  - [x] 8.3 Content logging (scene, hazards, objects, questions, answers) for review
- [x] 9. Hands-free Live mode (moves R5 voice from push-to-talk to streaming; overturns the design's "Expo Go can't stream audio" assumption)
  - [x] 9.1 Feasibility: SDK 58 `AudioStream` on device (16 kHz, about 100 ms buffers) + Gemini Live transcript output from the laptop
  - [x] 9.2 Server `/live` WebSocket relay to `gemini-3.8-live`; Gemini's audio dropped, transcript forwarded
  - [x] 9.3 App Live client: wake word "Iris", sentence-by-sentence speech through `SpeechQueue` (alerts still interrupt), echo guard, auto-reconnect
  - [x] 9.4 Tests: wake-word gating, streaming sentences, alert interrupts a Live answer, safety filter on Live output
- [x] 10. Hazard precision (R6.1, R6.2): walking-path-only prompt rules, no "camera is dark" hazards, server-side backstop filter
- [x] 11. Iris Web for judges (`web/`, Vercel): same core + agents; browser Live via single-use ephemeral tokens; skips unchanged frames to save quota; access code + rate limit
- [x] 12. Property-based tests (fast-check) for R7, R6.3, R2.3/R5.3, R8
  - Found: `sanitizeSpeech` was not idempotent (a duplicated reminder). Fixed.
- [x] 13. Kiro steering (`.kiro/steering/`) and hooks (`.kiro/hooks/`) capturing the rules and lessons from this build

## Open

- [ ] 14. Live session refreshes memory too often (relative timestamps change every minute). Throttle to at most once per 60–90 s (done on web, pending on the phone relay)
- [ ] 15. Deploy `web/` to Vercel and add the URL to the submission
