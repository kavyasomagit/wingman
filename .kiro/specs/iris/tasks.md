# Iris: Tasks (v1, ordered for a 2-hour build)

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
- [x] 6. Typecheck, run tests, smoke-test server with the real Gemini key. (models: gemini-3.5-flash for answers, gemini-3.5-flash-lite for frames)
- [ ] 7. Demo on phone via Expo Go; README with run steps and demo script. (README done)
