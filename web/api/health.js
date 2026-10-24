import { KEY, MODEL, FAST_MODEL, LIVE_MODEL } from './_lib/iris.js';

export default function health(req, res) {
  res.status(200).json({
    ok: !!KEY,
    codeRequired: !!process.env.DEMO_CODE,
    models: { ask: MODEL, frames: FAST_MODEL, live: LIVE_MODEL },
  });
}
