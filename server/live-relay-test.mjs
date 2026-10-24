// Tests the /live relay end to end, acting like the phone: binary PCM frames + JSON control messages.
// Usage: node live-relay-test.mjs   (server must be running)
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = (process.env.IRIS_URL || 'http://localhost:8787').replace(/^http/, 'ws');
const wav = fs.readFileSync('smoke-assets/q16.wav');
const pcm = wav.subarray(wav.indexOf(Buffer.from('data')) + 8);
const img = fs.readFileSync('smoke-assets/frame.jpg').toString('base64');

const ws = new WebSocket(`${BASE}/live`);
const t0 = Date.now();
let speechEnd = 0;
let heard = '';
let text = '';
let firstText = null;
const timer = setTimeout(() => { console.log('TIMEOUT', { heard, text }); process.exit(1); }, 30000);

ws.on('open', () => ws.send(JSON.stringify({ type: 'start', memory: 'LAST SEEN: keys - on the kitchen counter near the red mug - 4 minutes ago' })));
ws.on('message', async (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'ready') {
    console.log(`ready in ${Date.now() - t0}ms`);
    ws.send(JSON.stringify({ type: 'frame', data: img }));
    const all = Buffer.concat([pcm, Buffer.alloc(3200 * 15)]);
    for (let i = 0; i < all.length; i += 3200) {
      ws.send(all.subarray(i, i + 3200), { binary: true });
      if (i + 3200 >= pcm.length && !speechEnd) speechEnd = Date.now();
      await new Promise((r) => setTimeout(r, 100));
    }
  } else if (m.type === 'heard') heard += m.text;
  else if (m.type === 'text') {
    if (firstText == null) firstText = Date.now() - speechEnd;
    text += m.text;
  } else if (m.type === 'turn_complete') {
    console.log({ heard, text, firstTextAfterSpeechMs: firstText, doneMs: Date.now() - speechEnd });
    clearTimeout(timer);
    ws.close();
    process.exit(text ? 0 : 1);
  } else console.log(m);
});
ws.on('error', (e) => { console.log('ws error', e.message); process.exit(1); });
