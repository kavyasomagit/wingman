# Iris

AI companion for blind and low-vision people. The phone is worn on a lanyard or chest clip with the camera facing out. Iris remembers what it has seen ("your keys are on the kitchen counter next to the red mug; I saw them 4 minutes ago") and warns about hazards without being asked. It supports a cane or guide dog and never replaces them, and it never tells the user something is "safe".

Spec: [requirements](.kiro/specs/iris/requirements.md) · [design](.kiro/specs/iris/design.md) · [tasks](.kiro/specs/iris/tasks.md)

## Layout

- `server/`: tiny Node proxy holding the Gemini key (`/api/perceive`, `/api/ask`, `/api/summarize`, `/health`). No dependencies.
- `app/`: Expo app (Expo Go). Agents in `app/src/agents.ts`; pure, tested logic in `app/src/core/`.

## Run

1. **Server** (laptop):
   ```bash
   cp server/.env.example server/.env   # put GEMINI_API_KEY in it
   cd server && npm start               # listens on :8787
   npm run smoke                        # optional end-to-end check against Gemini
   ```
2. **App**: set the laptop's LAN IP in `app/.env`:
   ```
   EXPO_PUBLIC_IRIS_API_URL=http://<laptop-ip>:8787
   ```
   ```bash
   cd app && npx expo start
   ```
   Scan the QR code with Expo Go. You can also change the server address in the app under "Demo controls".
3. **Tests**: `cd app && npm test`

If the venue Wi-Fi blocks phone-to-laptop traffic, use a phone hotspot for both devices, or run `npx expo start --tunnel` together with a tunnel for the server (for example `npx localtunnel --port 8787`) and paste that URL into the app.

## Demo script

1. Tap **Start Iris**. Iris says "Iris is watching."
2. Hold the keys in view, then put them on a table next to a mug. Wait about 8 seconds (two frames).
3. Point the camera at a step, a chair in the path, or an open door. Iris warns you and vibrates without being asked. The same warning won't repeat for 15 seconds.
4. Hold the yellow area and ask "Where did I leave my keys?" Iris answers from memory with how long ago it saw them.
5. Ask "What's in front of me?" or "Read this sign."
6. Tap **Test interrupt** to show a hazard alert cutting into a long answer, after which the answer resumes.

Asking "Is it safe to cross?" never gets a "safe" answer. Iris describes what it sees and points the user to their cane, guide dog, or crossing signals.

## Live mode (default)

The phone streams 16 kHz microphone audio (expo-audio `AudioStream`) and camera frames over a WebSocket to the server's `/live` relay. The server holds a `gemini-3.8-live` session and sends back only the answer text. The phone speaks that text sentence by sentence through the priority queue, so Guardian alerts still interrupt it.
- Hands-free: start with "Iris…". Speech without the wake word is ignored (toggle under Demo controls).
- While Iris is speaking, the mic sends silence so the model doesn't hear Iris's own voice.
- The big button pauses or resumes listening. "Mode" switches back to push-to-talk.
- Test the relay from the laptop: `cd server && node live-relay-test.mjs`.

## v1 limits / v2

v1 uses snapshots every ~4 s plus push-to-talk, because Expo Go can't stream audio in real time. Hazard warnings therefore lag by 2-5 s and are a supplement only. v2 would use an Expo development build with Gemini Live API streaming and on-device hazard detection.
