// Request guard shared by all Vercel functions: method check, optional demo access code,
// best-effort per-IP rate limit (per warm instance), uniform JSON errors.
import { KEY } from './iris.js';

const hits = new Map();

function rateLimited(ip, limit) {
  const now = Date.now();
  const e = hits.get(ip) ?? { start: now, n: 0 };
  if (now - e.start > 60_000) {
    e.start = now;
    e.n = 0;
  }
  e.n++;
  hits.set(ip, e);
  if (hits.size > 5000) hits.clear();
  return e.n > limit;
}

export function route(fn, { method = 'POST', limit = 40 } = {}) {
  return async (req, res) => {
    try {
      if (req.method !== method) return res.status(405).json({ error: 'Method not allowed' });
      if (!KEY) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
      const code = process.env.DEMO_CODE;
      if (code && req.headers['x-iris-code'] !== code) return res.status(401).json({ error: 'Access code required' });
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '?').split(',')[0].trim();
      if (rateLimited(ip, limit)) return res.status(429).json({ error: 'Too many requests, slow down' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {};
      const t0 = Date.now();
      const out = await fn(body, req);
      console.log(`${req.url} 200 ${Date.now() - t0}ms`);
      return res.status(200).json(out);
    } catch (e) {
      console.error(`${req.url} ${e.status || 500} ${e.message}`);
      const status = e.status || 500;
      return res.status(status).json({ error: status < 500 ? e.message : 'Upstream error' });
    }
  };
}
