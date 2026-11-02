// Pulse server-side endpoint: POST /api/decide -> Perplexity Decisions API.
//
// Runs as a Cloudflare Pages "advanced mode" worker (this file, with _routes.json limiting it
// to /api/*; every other path is served from static assets). The same handler is imported by
// tools/coach-proxy.mjs and tools/coach-local.mjs to serve /api/decide from the Mac instead.
//
// The Perplexity API key NEVER reaches the browser: it is read from the server environment
// (Pages project secret / env var PERPLEXITY_API_KEY). Callers must present a bearer token:
//   - Pages: env PULSE_API_TOKEN (a long random secret the user also pastes into Pulse
//     Settings -> Fuel -> Endpoint token), compared in constant time.
//   - Mac proxy: the caller's gateway/bridge token, checked by the proxy before calling here
//     (pass { authorize: async () => true }).
// Requests are validated (model whitelist, question shapes and counts, note length, only
// JPEG/PNG/WebP data-URL images, body size) so the endpoint can't be used as a generic relay.
//
// Response: { model, answers, usage, request_id } (answers exactly as the Decisions API
// returns them: noul -> {type, noul}; choice -> {type, choice, confidence, probabilities};
// score -> {type, score, confidence, legend, probabilities}).

const API = 'https://api.perplexity.ai/v1/decisions';
export const DECIDE_MODELS = ['pplx-decider-v1.2', 'pplx-decider-flash-v1.2'];
const MAX_BODY = 6 * 1024 * 1024;      // ~1024 px JPEG as base64 is well under 1 MB
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});
const err = (status, message) => json(status, { error: { message } });

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)); const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const str = (v, max) => typeof v === 'string' && v.length <= max;

/** Validate a client request. Returns { body } (clean body for Perplexity) or { error }. */
export function validateDecide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'JSON object required' };
  const model = input.model || DECIDE_MODELS[0];
  if (!DECIDE_MODELS.includes(model)) return { error: `model must be one of ${DECIDE_MODELS.join(', ')}` };
  const s = input.state;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'state object required' };
  const state = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'photo') {
      if (v == null) continue;
      const url = v?.image_url?.url;
      if (v?.type !== 'image_url' || !str(url, MAX_IMAGE_CHARS) || !IMG.test(url)) return { error: 'photo must be a JPEG/PNG/WebP data URL image part' };
      state.photo = { type: 'image_url', image_url: { url } };
    } else if (['meal', 'time'].includes(k)) {
      if (v != null && !str(v, 40)) return { error: `${k} too long` };
      state[k] = v ?? null;
    } else if (k === 'note') {
      if (v != null && !str(v, 1000)) return { error: 'note too long (1000 chars max)' };
      state.note = v ?? '';
    } else if (k === 'saved_meals') {
      if (!Array.isArray(v) || v.length > 40 || !v.every((x) => str(x, 200))) return { error: 'saved_meals must be up to 40 short strings' };
      state.saved_meals = v;
    } else return { error: `unknown state field ${k}` };
  }
  const qs = input.questions;
  if (!qs || typeof qs !== 'object' || Array.isArray(qs)) return { error: 'questions object required' };
  const names = Object.keys(qs);
  if (!names.length || names.length > 128) return { error: '1 to 128 questions required' };
  const questions = {};
  for (const n of names) {
    const q = qs[n];
    if (!NAME.test(n)) return { error: `bad question name ${n}` };
    if (!q || !['noul', 'choice', 'score'].includes(q.type)) return { error: `question ${n}: type must be noul, choice or score` };
    if (!str(q.instructions, 1500) || !q.instructions.trim()) return { error: `question ${n}: instructions required` };
    const out = { type: q.type, instructions: q.instructions };
    if (q.type === 'choice') {
      const c = q.criteria;
      const keys = c && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c) : [];
      if (!keys.length || keys.length > 255 || !keys.every((k) => NAME.test(k) && (c[k] === null || str(c[k], 300)))) return { error: `question ${n}: choice criteria invalid` };
      out.criteria = c;
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10 || !q.criteria.every((x) => str(x, 300))) return { error: `question ${n}: score criteria invalid` };
      out.criteria = q.criteria;
    } else if (q.criteria != null) {
      if (typeof q.criteria !== 'object' || !str(q.criteria.true, 300) || !str(q.criteria.false, 300)) return { error: `question ${n}: noul criteria invalid` };
      out.criteria = { true: q.criteria.true, false: q.criteria.false };
    }
    questions[n] = out;
  }
  return { body: { model, state, questions } };
}

/**
 * Core handler (Web Request -> Response).
 * @param {Request} request
 * @param {{PERPLEXITY_API_KEY?:string, PULSE_API_TOKEN?:string}} env
 * @param {{fetchImpl?:Function, authorize?:(req)=>Promise<boolean>}} [opts]
 */
export async function handleDecide(request, env, { fetchImpl = fetch, authorize } = {}) {
  const url = new URL(request.url);
  const health = url.pathname.endsWith('/api/decide/health');
  if (request.method !== (health ? 'GET' : 'POST')) return err(405, 'Method not allowed');
  const ok = authorize ? await authorize(request)
    : !!env.PULSE_API_TOKEN && safeEqual(request.headers.get('authorization') || '', `Bearer ${env.PULSE_API_TOKEN}`);
  if (!ok) return err(401, env.PULSE_API_TOKEN || authorize ? 'Invalid Pulse endpoint token' : 'Server not configured: set PULSE_API_TOKEN');
  if (!env.PERPLEXITY_API_KEY) return err(503, 'Server not configured: set the PERPLEXITY_API_KEY secret');
  if (health) return json(200, { ok: true, models: DECIDE_MODELS });
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return err(413, 'Request too large');
  let text;
  try { text = await request.text(); } catch { return err(400, 'Could not read body'); }
  if (text.length > MAX_BODY) return err(413, 'Request too large');
  let input;
  try { input = JSON.parse(text); } catch { return err(400, 'Invalid JSON'); }
  const v = validateDecide(input);
  if (v.error) return err(400, v.error);
  let up;
  try {
    up = await fetchImpl(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(v.body),
      signal: AbortSignal.timeout ? AbortSignal.timeout(45000) : undefined,
    });
  } catch (e) {
    return err(502, `Decisions API unreachable: ${e?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
  }
  const rid = up.headers.get('x-request-id') || null;
  if (!up.ok) {
    let msg = '';
    try { const j = JSON.parse(await up.text()); msg = j?.error?.message || ''; } catch { /* 404/405/504 have no JSON */ }
    const retry = up.headers.get('retry-after');
    // never echo upstream headers (they could carry account details); only status + message
    return json(up.status === 429 ? 429 : 502, { error: { message: `Decisions API ${up.status}${msg ? `: ${msg.slice(0, 300)}` : ''}`, upstream_status: up.status, request_id: rid } },
      retry ? { 'Retry-After': retry } : {});
  }
  let out;
  try { out = await up.json(); } catch { return err(502, 'Decisions API returned invalid JSON'); }
  return json(200, { model: out.model, answers: out.answers || {}, usage: out.usage || null, request_id: rid });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/decide' || pathname === '/api/decide/health') return handleDecide(request, env);
    if (pathname.startsWith('/api/')) return err(404, 'Not found');
    return env.ASSETS.fetch(request);
  },
};
