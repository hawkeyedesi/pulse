// Sends each saved workout into the user's OpenClaw coach session ("PULSE WORKOUT LOG v1")
// and tracks per-session delivery in IndexedDB (store "coachlog", keyPath sessionId):
//   { sessionId, status: 'pending'|'sending'|'sent'|'failed', attempts, sentCount,
//     queuedAt, lastAttemptAt, sentAt, error, reply, replyAt }
//
// Never blocks saving: the workout, samples and notes are already in IndexedDB before
// anything here runs, and every failure only marks the record 'failed' for a later retry
// (next app open, coming back online, or the "Send to coach" button).
//
// Dependencies are injected so this runs in Node tests with an in-memory db.

export const STORE = 'coachlog';
const RETRYABLE = new Set(['pending', 'failed', 'sending']);

/**
 * @param {object} deps
 * @param {{get, put, del?, getAll, getSamples}} deps.db
 * @param {(settings, text:string) => Promise<string>} deps.send   posts the log, resolves with the coach reply
 * @param {() => object} deps.getSettings
 * @param {(settings) => boolean} deps.isConfigured
 * @param {(session, notes, samples, settings, opts) => {text, summary}} deps.buildLog
 * @param {() => boolean} [deps.online]
 * @param {() => number} [deps.now]
 */
export function createCoachSync({ db, send, getSettings, isConfigured, buildLog, online = () => true, now = () => Date.now() }) {
  const inflight = new Map();
  const listeners = new Set();
  const emit = (sessionId, rec) => listeners.forEach((fn) => { try { fn(sessionId, rec); } catch (e) { console.warn(e); } });

  async function status(sessionId) { return (await db.get(STORE, sessionId)) || null; }

  async function save(rec) { await db.put(STORE, rec); emit(rec.sessionId, rec); return rec; }

  /** Mark a session as waiting to be sent (no-op if already sent). */
  async function queue(sessionId) {
    const rec = await status(sessionId);
    if (rec?.status === 'sent') return rec;
    return save({ attempts: 0, sentCount: 0, ...(rec || {}), sessionId, status: 'pending', queuedAt: now() });
  }

  async function appendChat(sessionId, summary, reply) {
    const key = `session:${sessionId}`;
    const chat = (await db.get('chats', key)) || { key, messages: [] };
    const t = now();
    chat.messages.push({ role: 'user', content: summary, kind: 'workout-log', at: t });
    chat.messages.push({ role: 'assistant', content: reply || '(no reply)', kind: 'workout-log-reply', at: t + 1 });
    await db.put('chats', chat);
  }

  /**
   * Send one workout now. Concurrent calls for the same session share one request.
   * Resolves with the final record (never rejects).
   */
  function sendNow(sessionId) {
    if (inflight.has(sessionId)) return inflight.get(sessionId);
    const p = (async () => {
      const settings = getSettings();
      const session = await db.get('sessions', sessionId);
      if (!session || session.deleted || session.status !== 'complete') return status(sessionId);
      const prev = (await status(sessionId)) || { sessionId, attempts: 0, sentCount: 0, queuedAt: now() };
      if (!isConfigured(settings) || !online()) {
        return save({ ...prev, status: prev.status === 'sent' ? 'sent' : 'pending' });
      }
      let rec = await save({ ...prev, status: 'sending', lastAttemptAt: now(), attempts: (prev.attempts || 0) + 1 });
      try {
        const [notes, samples] = await Promise.all([db.get('notes', sessionId), db.getSamples(sessionId)]);
        const log = buildLog(session, notes, samples, settings, { revision: (prev.sentCount || 0) + 1, now: now() });
        const reply = await send(settings, log.text);
        if (!(await db.get('sessions', sessionId))) return null; // deleted meanwhile
        await appendChat(sessionId, log.summary, reply);
        rec = await save({ ...rec, status: 'sent', sentAt: now(), sentCount: (prev.sentCount || 0) + 1, error: null, reply: reply || '', replyAt: now() });
      } catch (e) {
        if (!(await db.get('sessions', sessionId))) return null;
        rec = await save({ ...rec, status: 'failed', error: String(e?.message || e).slice(0, 400) });
      }
      return rec;
    })().catch((e) => { console.warn('coach log send failed', e); return null; })
      .finally(() => inflight.delete(sessionId));
    inflight.set(sessionId, p);
    return p;
  }

  /** Retry every pending/failed (or interrupted 'sending') record, one at a time. */
  async function retryAll() {
    if (!isConfigured(getSettings()) || !online()) return 0;
    const all = (await db.getAll(STORE)).filter((r) => RETRYABLE.has(r.status) && !inflight.has(r.sessionId))
      .sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
    let ok = 0;
    for (const r of all) {
      const res = await sendNow(r.sessionId);
      if (res?.status === 'sent') ok++;
    }
    return ok;
  }

  return {
    status, queue, sendNow, retryAll,
    inFlight: (sessionId) => inflight.has(sessionId),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
