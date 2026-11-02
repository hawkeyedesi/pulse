// Fuel: client for the server-side decision endpoint (the Perplexity key lives only there),
// plus browser image helpers. Modes (Settings -> Fuel -> Estimates):
//   pages : same-origin Cloudflare Pages function  POST ./api/decide  (Bearer = endpoint token)
//   proxy : the Mac bridge/proxy                    POST {gateway}/api/decide (Bearer = gateway token)
//   mock  : deterministic local stand-in (tests / demo; nothing leaves the device)
//   off   : no decision layer; the food coach estimates from the photo
import { mockDecide } from './fuel-questions.js';
import { gatewayBase } from './coach.js';

export const DECIDE_MODES = ['pages', 'proxy', 'mock', 'off'];
export const DECIDE_MODE_LABELS = {
  pages: 'Pulse server (Cloudflare Pages function)', proxy: 'My Mac (coach bridge / proxy)', mock: 'Mock (demo, offline)', off: 'Off (coach estimates)',
};

export function decideEndpoint(settings, base = (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/')) {
  if (settings.decideMode === 'proxy') return { url: `${gatewayBase(settings)}/api/decide`, token: String(settings.gatewayToken || '').trim() };
  return { url: new URL('api/decide', base).href, token: String(settings.decideToken || '').trim() };
}

/** Returns decide(request) for the configured mode, or null when off. */
export function makeDecider(getSettings, { fetchImpl = (...a) => fetch(...a), delayMs = 250 } = {}) {
  return async (request) => {
    const s = getSettings();
    if (s.decideMode === 'mock') { await new Promise((r) => setTimeout(r, delayMs)); return mockDecide(request); }
    const { url, token } = decideEndpoint(s);
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
    } catch (e) { throw new Error(`Estimate service unreachable (${e.message})`); }
    let j = null;
    try { j = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) { const e = new Error(j?.error?.message || `Estimate service error ${res.status}`); e.status = res.status; throw e; }
    if (!j || typeof j.answers !== 'object') throw new Error('Estimate service returned no answers');
    return j;
  };
}

export async function testDecide(settings, fetchImpl = (...a) => fetch(...a)) {
  if (settings.decideMode === 'mock') return 'Mock mode: estimates are simulated on this device.';
  if (settings.decideMode === 'off') return 'Off: the food coach estimates from the photo.';
  const { url, token } = decideEndpoint(settings);
  const res = await fetchImpl(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } });
  let j = null; try { j = await res.json(); } catch { /* */ }
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return `Connected. Models: ${(j.models || []).join(', ')}`;
}

// ---------------------------------------------------------------- images (browser only)
async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function toJpeg(src, maxSide, quality) {
  const w = src.width; const h = src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)); const ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  c.getContext('2d').drawImage(src, 0, 0, cw, ch);
  return c.toDataURL('image/jpeg', quality);
}

/** File -> { photo: ~1024 px JPEG data URL, thumb: ~160 px JPEG data URL } */
export async function preparePhoto(file, { maxSide = 1024, thumbSide = 160 } = {}) {
  const bmp = await loadBitmap(file);
  const photo = toJpeg(bmp, maxSide, 0.82);
  const thumb = toJpeg(bmp, thumbSide, 0.7);
  bmp.close?.();
  return { photo, thumb };
}
