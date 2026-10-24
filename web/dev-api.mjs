// Local stand-in for Vercel functions: serves api/*.js on :8788 (Vite proxies /api here).
// Reads ../server/.env or ./.env for GEMINI_API_KEY.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

for (const f of ['.env', '../server/.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// Web defaults differ from the phone server: GEMINI_FAST_MODEL from server/.env would override them, so drop it.
delete process.env.GEMINI_FAST_MODEL;

const routes = ['perceive', 'ask', 'summarize', 'live-token', 'health'];
const handlers = Object.fromEntries(
  await Promise.all(routes.map(async (r) => [r, (await import(`./api/${r}.js`)).default])),
);

http
  .createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.replace(/^\/api\//, '');
    const h = handlers[name];
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (o) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(o)));
    if (!h) return res.status(404).json({ error: 'not found' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      } catch {
        req.body = {};
      }
      h(req, res);
    });
  })
  .listen(8788, () => console.log('dev api on :8788'));
