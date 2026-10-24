// End-to-end smoke test against a running proxy (macOS: uses `say` and `sips` to make test assets).
// Usage: node smoke.mjs [path/to/photo.jpg]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.IRIS_URL || 'http://localhost:8787';
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'smoke-assets');
mkdirSync(dir, { recursive: true });

let img = process.argv[2];
if (!img) {
  const pics = '/System/Library/Desktop Pictures';
  const src = existsSync(pics) && readdirSync(pics).find((f) => /\.(heic|jpg|png)$/i.test(f));
  img = path.join(dir, 'frame.jpg');
  if (src) execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '640', path.join(pics, src), '--out', img], { stdio: 'ignore' });
}
const audioPath = path.join(dir, 'question.m4a');
if (!existsSync(audioPath)) {
  // Note: on some Macs `say` writes a silent file; put a real recording at smoke-assets/question.m4a if so.
  const aiff = path.join(dir, 'question.aiff');
  execFileSync('say', ['-o', aiff, 'Where did I leave my keys?']);
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-c', '1', aiff, audioPath]);
}

const image = readFileSync(img).toString('base64');
const audio = readFileSync(audioPath).toString('base64');
const headers = { 'content-type': 'application/json', ...(process.env.IRIS_TOKEN ? { 'x-iris-token': process.env.IRIS_TOKEN } : {}) };
const post = async (p, body) => {
  const t = Date.now();
  const r = await fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json();
  console.log(`\n${p} -> ${r.status} in ${Date.now() - t}ms\n`, JSON.stringify(j, null, 2));
  if (!r.ok) process.exitCode = 1;
  return j;
};

console.log((await (await fetch(BASE + '/health')).json()));
await post('/api/perceive', { image });
await post('/api/ask', {
  audio,
  audioMime: 'audio/mp4',
  image,
  memory: 'LAST SEEN OBJECTS (most recent first):\n- keys: on the kitchen counter (near red mug) - 4 minutes ago',
});
await post('/api/summarize', { kind: 'short', events: '- [5 minutes ago] User put keys on the kitchen counter next to a red mug.' });
