// Mints a single-use Gemini Live ephemeral token so the browser can open the Live WebSocket
// directly (Vercel functions can't hold WebSockets). The real API key never leaves the server.
// The session setup (model + system prompt with the user's memory) is built here.
import { KEY, LIVE_MODEL, LIVE_SYSTEM } from './_lib/iris.js';
import { route } from './_lib/http.js';

async function liveToken({ memory }) {
  const now = Date.now();
  const r = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
    }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.name) {
    const e = new Error(`token ${r.status}: ${tok?.error?.message ?? 'failed'}`);
    e.status = 502;
    throw e;
  }
  return {
    token: tok.name,
    url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tok.name)}`,
    setup: {
      model: `models/${LIVE_MODEL}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: LIVE_SYSTEM(String(memory ?? '').slice(0, 15000)) }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

export default route(liveToken, { limit: 10 });
