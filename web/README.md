# Iris Web

Browser version of Iris for judges to try without installing anything. It uses the same agents, memory, priority speech queue, safety filter and tests as the phone app. It runs on desktop Chrome, Android Chrome, and iOS Safari.

## How it works
- **Camera frames** (`/api/perceive`): Guardian hazard warnings plus the Scene Logger's last-seen index. Frames are sent every 5 s, and only when the view has changed, which saves quota.
- **Hands-free Live** (`/api/live-token`): Vercel functions can't hold WebSockets. Instead the function mints a single-use Gemini ephemeral token, and the browser connects directly to the Gemini Live API. The API key never reaches the browser. Microphone audio streams as 16 kHz PCM through an AudioWorklet. Iris speaks the answer text with the Web Speech API, through the same priority queue, so hazard alerts still interrupt it.
- **Push-to-talk fallback** (`/api/ask`): MediaRecorder audio plus a fresh frame plus memory.
- **Memory** is kept in `localStorage` (this browser only).

## Deploy to Vercel
1. Vercel → **Add New → Project** → import `kavyasomagit/wingman`.
2. Set **Root Directory** to `web`. The framework preset is detected as Vite.
3. Under **Environment Variables**, add `GEMINI_API_KEY`. Optionally add `DEMO_CODE` as an access code for judges.
4. Click **Deploy**. Judges open `https://<your-app>.vercel.app/?code=<DEMO_CODE>`.

## Local dev
```bash
cd web && npm install
npm run dev        # API on :8788 (reads ../server/.env), site on :5173
npm test           # 24 unit tests (shared core rules + Live gating)
```
Camera and microphone access require HTTPS or `localhost`. To test on a phone, deploy, or use an HTTPS tunnel.

## Try it
1. Click **Start Iris** and allow camera and microphone. Turn the sound on.
2. Show keys or a mug to the camera, put it down, then point the camera somewhere else.
3. Say **"Iris, where are my keys?"**, **"Iris, what's in front of me?"** or **"Iris, read this."**
4. Point the camera at a chair or a step a short distance ahead. Iris warns without being asked.
5. Click **Test interrupt** to see a hazard alert cut into an answer, after which the answer resumes.

Iris supplements a cane or guide dog. It never says anything is "safe".
