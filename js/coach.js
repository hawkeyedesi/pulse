// Coach chat against the user's OpenClaw Gateway (OpenAI-compatible Chat Completions).
// Docs: https://docs.openclaw.ai/gateway/openai-http-api
//   POST {gateway}/v1/chat/completions, Authorization: Bearer <gateway token>,
//   model "openclaw/default" (stable alias for the default agent), stream: true -> SSE.
//   Optional header x-openclaw-session-key routes every request into one existing
//   OpenClaw session (e.g. the user's Telegram coach thread). Without it each call is
//   stateless. Keys in the reserved namespaces subagent:, cron:, acp: are rejected (400).

import { fmtDuration, fmtDate, zoneRangeLabel, ZONE_NAMES, lapStats } from './stats.js';

export const COACH_SYSTEM_PROMPT = [
  'You are my personal training coach, talking to me inside Pulse, my heart-rate workout tracker.',
  'Pulse records my Polar chest strap and my dictated notes; it sends you structured workout data below.',
  'Give specific, practical feedback grounded in the numbers (zones, average/max HR, laps, effort, sleep, flags).',
  'Be concise: a few short paragraphs or bullets. Flag anything that looks like a safety issue (pain, dizziness, unusually high HR).',
  'If you keep a training log or memory, record this workout there and suggest what I should do next session.',
].join(' ');

export function coachConfigured(settings) {
  return !!(settings.gatewayUrl && settings.gatewayToken);
}

export const SESSION_KEY_HEADER = 'x-openclaw-session-key';
const RESERVED_SESSION_PREFIXES = ['subagent:', 'cron:', 'acp:'];

/** Trimmed session key from settings ('' when unset). */
export function coachSessionKey(settings) {
  return String(settings?.coachSessionKey || '').trim();
}

/** Problem with a session key, or '' if it is usable. */
export function sessionKeyIssue(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  const bad = RESERVED_SESSION_PREFIXES.find((p) => k.toLowerCase().startsWith(p));
  if (bad) return `Session keys starting with “${bad}” are reserved by OpenClaw and will be rejected.`;
  if (/[\r\n]/.test(k)) return 'Session key must be a single line.';
  return '';
}

/**
 * Auto-send each saved workout? Explicit setting wins; otherwise on when a session key is set.
 * Always false when the coach itself is not configured.
 */
export function autoSendEnabled(settings) {
  if (!coachConfigured(settings)) return false;
  if (typeof settings.coachAutoSend === 'boolean') return settings.coachAutoSend;
  return !!coachSessionKey(settings);
}

export function gatewayBase(settings) {
  return String(settings.gatewayUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Request headers for the gateway (bearer token + optional session routing). */
export function coachHeaders(settings, { stream = true } = {}) {
  const h = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${String(settings.gatewayToken || '').trim()}`,
    Accept: stream ? 'text/event-stream, application/json' : 'application/json',
  };
  const key = coachSessionKey(settings);
  if (key) h[SESSION_KEY_HEADER] = key;
  return h;
}

/** Human-readable summary of one session, used as coach context. */
export function sessionContext(session, notes, samples, settings) {
  if (!session) return '';
  const s = session.summary || {};
  const total = (s.zones || []).reduce((a, b) => a + b, 0) || 1;
  const lines = [];
  lines.push(`Workout: ${fmtDate(session.startedAt, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' })} at ${new Date(session.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  lines.push(`Type: ${session.type || notes?.parsed?.type || 'Unspecified'}`);
  lines.push(`Duration: ${fmtDuration(session.durationS)} (active time${pausedS(session) ? `; paused ${fmtDuration(pausedS(session))}` : ''})`);
  lines.push(`Heart rate: avg ${s.avg ?? '–'} bpm, max ${s.max ?? '–'} bpm, min ${s.min ?? '–'} bpm (my max HR setting: ${settings.maxHr})`);
  lines.push(`Estimated calories: ${s.calories ?? '–'} kcal`);
  lines.push('Time in zones: ' + (s.zones || []).map((z, i) =>
    `Z${i + 1} ${ZONE_NAMES[i]} (${zoneRangeLabel(i + 1, settings.maxHr, settings.zones)} bpm) ${fmtDuration(z)} ${Math.round((z / total) * 100)}%`).join('; '));
  if (samples?.length && session.laps?.length) {
    const ls = lapStats(samples, session.laps);
    lines.push(`Laps/sets (${ls.length}): ` + ls.map((l) => `#${l.lap} at ${fmtDuration(l.startS)} for ${fmtDuration(l.durationS)}, avg ${l.avg}, max ${l.max}`).join('; '));
  } else {
    lines.push('Laps/sets: none marked');
  }
  const gaps = (session.gaps || []).filter((g) => g.end);
  if (gaps.length) lines.push(`Signal gaps: ${gaps.length} (total ${fmtDuration(gaps.reduce((a, g) => a + (g.end - g.start) / 1000, 0))})`);
  if (notes?.text) lines.push(`My notes (dictated): "${notes.text.trim()}"`);
  if (notes?.parsed?.chips?.length) lines.push(`Parsed from notes: ${notes.parsed.chips.map((c) => c.label).join(' · ')}`);
  return lines.join('\n');
}

function pausedS(session) {
  return Math.round((session.pauses || []).reduce((a, p) => a + ((p.end || p.start) - p.start), 0) / 1000);
}

export function trendContext(trends) {
  if (!trends) return '';
  const lines = [`Recent trend (since ${fmtDate(trends.since)}): ${trends.count} workouts, total ${fmtDuration(trends.totalS, { long: true })}, avg session HR ${trends.avgSessionHr ?? '–'} bpm, ${trends.workoutsThisWeek} this week.`];
  lines.push('Weekly minutes: ' + trends.weeks.map((w) => `${fmtDate(w.start, { month: 'short', day: 'numeric' })}: ${Math.round(w.minutes)}`).join(', '));
  const z = trends.weeks.reduce((acc, w) => acc.map((v, i) => v + w.zones[i]), [0, 0, 0, 0, 0]);
  const tot = z.reduce((a, b) => a + b, 0) || 1;
  lines.push('Zone share over the period: ' + z.map((v, i) => `Z${i + 1} ${Math.round((v / tot) * 100)}%`).join(', '));
  if (trends.patterns?.length) lines.push('Patterns Pulse noticed: ' + trends.patterns.join(' '));
  return lines.join('\n');
}

export function buildMessages({ sessionText, trendText, history }) {
  const context = [COACH_SYSTEM_PROMPT, sessionText && `\n--- Selected workout ---\n${sessionText}`, trendText && `\n--- Trends ---\n${trendText}`]
    .filter(Boolean).join('\n');
  return [{ role: 'system', content: context }, ...history.map(({ role, content }) => ({ role, content }))];
}

/**
 * Send a chat request. Streams when the gateway returns text/event-stream.
 * @param {{gatewayUrl, gatewayToken, coachModel}} settings
 * @param {Array} messages
 * @param {(delta:string, full:string)=>void} onDelta
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} full assistant text
 */
export async function sendChat(settings, messages, onDelta = () => {}, signal) {
  // With a session key, OpenClaw keeps the thread's own history: send only context + the newest turn.
  if (settings.coachSessionKey && messages.length > 2) {
    const sys = messages.filter((m) => m.role === 'system');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    messages = [...sys, ...(lastUser ? [lastUser] : [])];
  }
  const res = await postCompletion(settings, { stream: true, messages }, signal);
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream') || !res.body) {
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content ?? '';
    onDelta(text, text);
    return text;
  }
  return readSse(res.body, onDelta);
}

/**
 * One non-streaming user message into the configured session (used for workout logs).
 * Tolerates a gateway that streams anyway. Rejects on network/HTTP/agent errors or timeout.
 */
export async function sendToSession(settings, content, { signal, timeoutMs = 180000 } = {}) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await postCompletion(settings, { stream: false, messages: [{ role: 'user', content }] }, ac.signal);
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream') && res.body) return await readSse(res.body);
    const j = await res.json();
    if (j.error) throw new Error(`Coach error: ${j.error.message || JSON.stringify(j.error)}`);
    return j.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    if (ac.signal.aborted && !signal?.aborted) throw new Error(`Coach did not answer within ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function postCompletion(settings, { stream, messages }, signal) {
  const base = gatewayBase(settings);
  let res;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: coachHeaders(settings, { stream }),
      body: JSON.stringify({ model: settings.coachModel || 'openclaw/default', stream, messages }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Could not reach the coach at ${base}. Check Tailscale is connected and the CORS proxy is running (see README). (${e.message})`);
  }
  if (!res.ok) {
    let detail = '';
    try { const t = await res.text(); try { const j = JSON.parse(t); detail = j.error?.message || JSON.stringify(j); } catch { detail = t; } } catch { /* ignore */ }
    const hint = res.status === 401 ? ' Check the gateway token in Settings.'
      : res.status === 400 && /session/i.test(detail) ? ' Check the coach session key in Settings.'
        : res.status === 404 || res.status === 405 ? ' Is gateway.http.endpoints.chatCompletions.enabled = true?' : '';
    const err = new Error(`Coach error ${res.status}: ${detail.slice(0, 300)}${hint}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** Parse an OpenAI-style SSE stream ("data: {json}" lines, ends with "data: [DONE]"). */
export async function readSse(body, onDelta = () => {}) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let streamError = null;
  const handleEvent = (raw) => {
    const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return data === '[DONE]';
    let j;
    try { j = JSON.parse(data); } catch { return false; }
    if (j.error) { streamError = j.error.message || JSON.stringify(j.error); return false; }
    const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
    if (delta) { full += delta; onDelta(delta, full); }
    return false;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
      if (handleEvent(ev)) { buf = ''; break; }
    }
  }
  if (buf.trim()) handleEvent(buf);
  if (streamError) {
    if (full) return `${full}\n\n[Coach stream error: ${streamError}]`;
    throw new Error(`Coach error: ${streamError}`);
  }
  return full;
}
