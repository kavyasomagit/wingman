---
inclusion: fileMatch
fileMatchPattern: ['app/**', 'server/**', 'web/api/**']
---

# Expo SDK 58 + Gemini: verified facts (do not trust training data)

These were all verified in this project. Prefer them over memory.

## Expo (SDK 58, React Native 0.88, Expo Go)
- Always install with `npx expo install <pkg>` so versions match SDK 58.
- Before using an Expo API, read its type definitions in `app/node_modules/<pkg>/build/*.d.ts`. APIs change every SDK.
- `expo-audio` has real-time microphone streaming in Expo Go: `useAudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16', onBuffer })`. Verified on Android 13: about 100 ms / 3200-byte buffers.
- `expo-file-system`: use `new File(uri).base64()` (new API). The legacy API is under `expo-file-system/legacy`.
- `expo-camera`: `CameraView` + `takePictureAsync({ quality, shutterSound: false })`. Wait for `onCameraReady`.
- iOS: `setAudioModeAsync({ allowsRecording: true })` routes speech to the earpiece. Turn it off after recording.

## Gemini (models available to this key, Oct 2026)
- `gemini-2.5-flash` and `gemini-2.5-flash-lite` are retired for new users (404).
- Frames: `gemini-3.1-flash-lite` (steady 1.8–3.4 s). Questions: `gemini-3.5-flash`. Live: `gemini-3.8-live`.
- `gemini-3.8-flash` / `3.7-flash` time out (30 s+) on image input. Don't use them.
- Gemini 3 thinking: use `thinkingLevel: 'minimal'` for lite models. `gemini-3.8-live` rejects MINIMAL.
- Live API: `responseModalities: ['TEXT']` is rejected (1007). Use AUDIO + `outputAudioTranscription: {}` and use the transcript.
- Live sessions with video need `contextWindowCompression: { slidingWindow: {} }`, otherwise they end after a short time.
- Browser Live: mint a single-use ephemeral token (`POST v1alpha/auth_tokens`), then connect to `...v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=`.
- Free tier: 500 requests/day per model. Always keep a fallback model, and it must differ from the primary.
- Audio input: `audio/mp4` (m4a) and `audio/pcm;rate=16000` both work. macOS `say --data-format=aac` writes silent files; don't use it for test audio.
