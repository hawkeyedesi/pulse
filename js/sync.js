// Optional Supabase sync. Local IndexedDB is always the source of truth on this device;
// completed sessions are queued (syncedAt < updatedAt) and pushed whenever we are online
// and signed in. Deletes go through an outbox. Other devices' sessions are pulled down.

import * as db from './db.js';
import { getSettings } from './settings.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
const LAST_PULL_KEY = 'pulse.lastPull';
const CHUNK = 500;

let client = null;
let clientKey = '';
let status = { state: 'off', message: 'Sync off' };
let syncing = null;
const subs = new Set();

function setStatus(state, message, extra = {}) {
  status = { state, message, ...extra, at: Date.now() };
  subs.forEach((fn) => fn(status));
}
export function syncStatus() { return status; }
export function onSyncStatus(fn) { subs.add(fn); fn(status); return () => subs.delete(fn); }

export function syncConfigured() {
  const s = getSettings();
  return !!(s.supabaseUrl && s.supabaseAnonKey);
}

export async function getClient() {
  const s = getSettings();
  if (!syncConfigured()) { client = null; setStatus('off', 'Sync off'); return null; }
  const key = `${s.supabaseUrl}|${s.supabaseAnonKey}`;
  if (client && clientKey === key) return client;
  const { createClient } = await import(SUPABASE_ESM);
  client = createClient(s.supabaseUrl.replace(/\/+$/, ''), s.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'pulse.supabase.auth' },
  });
  clientKey = key;
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') { cleanAuthHash(); syncNow(); }
    if (event === 'SIGNED_OUT') setStatus('signed-out', 'Signed out');
  });
  return client;
}

function cleanAuthHash() {
  if (/access_token=|error_description=/.test(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search + '#/');
  }
}

export async function currentUser() {
  const c = await getClient().catch((e) => { setStatus('error', `Could not load Supabase: ${e.message}`); return null; });
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session?.user || null;
}

/** Sends a magic link (and, if the email template includes {{ .Token }}, a 6-digit code). */
export async function sendMagicLink(email) {
  const c = await getClient();
  if (!c) throw new Error('Add your Supabase URL and anon key first');
  const redirect = location.origin + location.pathname;
  const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect, shouldCreateUser: true } });
  if (error) throw error;
}

export async function verifyCode(email, token) {
  const c = await getClient();
  const { error } = await c.auth.verifyOtp({ email, token: token.trim(), type: 'email' });
  if (error) throw error;
}

export async function signOut() {
  const c = await getClient();
  if (c) await c.auth.signOut();
}

export async function queueRemoteDelete(sessionId, wasSynced) {
  if (!wasSynced) return;
  await db.put('outbox', { kind: 'delete', sessionId, at: Date.now() });
}

export async function pendingCount() {
  const sessions = await db.getAll('sessions');
  const outbox = await db.getAll('outbox');
  return sessions.filter((s) => s.status === 'complete' && !s.deleted && !s.demo && (!s.syncedAt || s.updatedAt > s.syncedAt)).length + outbox.length;
}

/** Run one sync pass. Safe to call often; concurrent calls share one run. */
export function syncNow() {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      if (!syncConfigured()) { setStatus('off', 'Sync off'); return; }
      if (!navigator.onLine) { setStatus('offline', `Offline · ${await pendingCount()} waiting`); return; }
      const c = await getClient();
      const user = await currentUser();
      if (!user) { setStatus('signed-out', 'Not signed in'); return; }
      setStatus('syncing', 'Syncing…');
      await pushDeletes(c);
      const pushed = await pushSessions(c);
      const pulled = await pull(c);
      setStatus('ok', `Synced${pushed || pulled ? ` · ↑${pushed} ↓${pulled}` : ''}`, { user: user.email });
    } catch (e) {
      console.error('sync failed', e);
      setStatus('error', `Sync error: ${e.message || e}`);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function pushDeletes(c) {
  const outbox = await db.getAll('outbox');
  for (const item of outbox) {
    if (item.kind !== 'delete') continue;
    const id = item.sessionId;
    let r = await c.from('samples').delete().eq('session_id', id); if (r.error) throw r.error;
    r = await c.from('notes').delete().eq('session_id', id); if (r.error) throw r.error;
    r = await c.from('sessions').update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
    if (r.error) throw r.error;
    await db.del('outbox', item.id);
  }
}

function sessionRow(s) {
  return {
    id: s.id,
    started_at: new Date(s.startedAt).toISOString(),
    ended_at: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    type: s.type, source: s.source || 'ble', duration_s: s.durationS || 0,
    avg_hr: s.summary?.avg ?? null, max_hr: s.summary?.max ?? null, min_hr: s.summary?.min ?? null,
    calories: s.summary?.calories ?? null, zone_seconds: s.summary?.zones || [0, 0, 0, 0, 0],
    laps: s.laps || [], pauses: s.pauses || [], gaps: s.gaps || [], device: s.device || null,
    updated_at: new Date(s.updatedAt || Date.now()).toISOString(), deleted_at: null,
  };
}

async function pushSessions(c) {
  const sessions = (await db.getAll('sessions'))
    .filter((s) => s.status === 'complete' && !s.deleted && !s.demo && (!s.syncedAt || s.updatedAt > s.syncedAt));
  let n = 0;
  for (const s of sessions) {
    let r = await c.from('sessions').upsert(sessionRow(s), { onConflict: 'id' });
    if (r.error) throw r.error;
    if (!s.samplesSynced) {
      const samples = await db.getSamples(s.id);
      for (let i = 0; i < samples.length; i += CHUNK) {
        const rows = samples.slice(i, i + CHUNK).map((x) => ({
          session_id: s.id, seq: x.seq, t: new Date(x.t).toISOString(), elapsed_s: x.elapsed_s,
          hr: x.hr, rr_ms: x.rr_ms || [], lap: x.lap ?? null,
        }));
        r = await c.from('samples').upsert(rows, { onConflict: 'session_id,seq' });
        if (r.error) throw r.error;
      }
    }
    const note = await db.get('notes', s.id);
    if (note) {
      r = await c.from('notes').upsert({
        session_id: s.id, text: note.text || '', parsed: note.parsed || {},
        updated_at: new Date(note.updatedAt || Date.now()).toISOString(),
      }, { onConflict: 'session_id' });
      if (r.error) throw r.error;
    }
    const fresh = await db.get('sessions', s.id);
    if (fresh) await db.put('sessions', { ...fresh, syncedAt: s.updatedAt, samplesSynced: true });
    n++;
  }
  return n;
}

async function pull(c) {
  const since = localStorage.getItem(LAST_PULL_KEY) || '1970-01-01T00:00:00Z';
  const startedPull = new Date().toISOString();
  const { data: rows, error } = await c.from('sessions').select('*').gt('updated_at', since).order('updated_at').limit(1000);
  if (error) throw error;
  let n = 0;
  for (const row of rows || []) {
    const local = await db.get('sessions', row.id);
    if (row.deleted_at) { if (local) await db.deleteSessionLocal(row.id); continue; }
    const remoteUpdated = Date.parse(row.updated_at);
    if (local && local.updatedAt >= remoteUpdated) continue;
    const s = {
      id: row.id, startedAt: Date.parse(row.started_at), endedAt: row.ended_at ? Date.parse(row.ended_at) : null,
      status: 'complete', type: row.type, source: row.source, device: row.device,
      laps: row.laps || [], pauses: row.pauses || [], gaps: row.gaps || [], durationS: row.duration_s,
      summary: { avg: row.avg_hr, max: row.max_hr, min: row.min_hr, calories: row.calories, zones: row.zone_seconds || [0, 0, 0, 0, 0] },
      updatedAt: remoteUpdated, syncedAt: remoteUpdated, samplesSynced: true, schema: 1,
    };
    if (!local) {
      // download samples in pages of 1000 (PostgREST default max rows)
      for (let from = 0; ; from += 1000) {
        const r = await c.from('samples').select('seq,t,elapsed_s,hr,rr_ms,lap').eq('session_id', row.id).order('seq').range(from, from + 999);
        if (r.error) throw r.error;
        await db.putMany('samples', r.data.map((x) => ({
          sessionId: row.id, seq: x.seq, t: Date.parse(x.t), elapsed_s: x.elapsed_s, hr: x.hr, rr_ms: x.rr_ms || [], lap: x.lap,
        })));
        if (r.data.length < 1000) break;
      }
    }
    const nr = await c.from('notes').select('*').eq('session_id', row.id).maybeSingle();
    if (nr.error) throw nr.error;
    if (nr.data) await db.put('notes', { sessionId: row.id, text: nr.data.text, parsed: nr.data.parsed, updatedAt: Date.parse(nr.data.updated_at) });
    await db.put('sessions', s);
    n++;
  }
  localStorage.setItem(LAST_PULL_KEY, startedPull);
  return n;
}

// Background triggers
let bound = false;
export function startAutoSync() {
  if (bound) return;
  bound = true;
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => setStatus('offline', 'Offline'));
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 5 * 60 * 1000);
  if (syncConfigured()) syncNow();
}
