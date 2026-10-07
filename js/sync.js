// Optional Supabase sync, shaped like the coach's OpenClaw health.sqlite3 (days, workouts,
// meals, weigh_ins; see supabase/schema.sql). Local IndexedDB is always the source of truth
// on this device. Completed, non-demo sessions are queued (cloudSyncedAt < updatedAt) and
// pushed whenever we are online and signed in (bookkeeping field: cloudSyncedAt; the v1
// field syncedAt is ignored so every device re-pushes its history into `workouts` once):
//   1. upsert days(user_id, date) (never touching the coach's day notes)
//   2. upsert workouts on log_id (coach columns + extras, full Pulse JSON in polar_json;
//      `number` is never sent so the coach-assigned session number survives)
// Demo sessions never leave the device. Raw RR intervals are never uploaded (hrv_json is a
// whole-session summary; hr_trace_json is the 5-s averaged trace). Deletes go through an
// outbox (soft delete: workouts.deleted_at). Pulse workouts from other devices are pulled
// down and rebuilt from polar_json + hr_trace_json.

import * as db from './db.js';
import { getSettings } from './settings.js';
import { workoutLogData, supabaseWorkoutRow, isDemoSession, KINDS } from './workout-log.js';
import { parseNotes } from './notes-parser.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
const LAST_PULL_KEY = 'pulse.lastPull.v2'; // v2: workouts table (v1 pulled the old sessions table)

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
  return sessions.filter(needsPush).length + outbox.length;
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
      const pushed = await pushWorkouts(c, user);
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
    const r = await c.from('workouts').update({ deleted_at: new Date().toISOString() }).eq('log_id', item.sessionId);
    if (r.error) throw r.error;
    await db.del('outbox', item.id);
  }
}

/** Local session that should be (re)pushed to Supabase. */
export function needsPush(s) {
  return !!s && s.status === 'complete' && !s.deleted && !isDemoSession(s) && (!s.cloudSyncedAt || s.updatedAt > s.cloudSyncedAt);
}

async function pushWorkouts(c, user) {
  const settings = getSettings();
  const sessions = (await db.getAll('sessions')).filter(needsPush);
  let n = 0;
  for (const s of sessions) {
    const [notes, samples] = await Promise.all([db.get('notes', s.id), db.getSamples(s.id)]);
    const data = workoutLogData(s, notes, samples, settings, { revision: s.revision || 1 });
    // days first (coach rule), without overwriting the coach's notes for that day
    let r = await c.from('days').upsert({ user_id: user.id, date: data.date }, { onConflict: 'user_id,date', ignoreDuplicates: true });
    if (r.error) throw r.error;
    r = await c.from('workouts').upsert(supabaseWorkoutRow(data, user.id), { onConflict: 'log_id' });
    if (r.error) throw r.error;
    const fresh = await db.get('sessions', s.id);
    if (fresh) await db.put('sessions', { ...fresh, cloudSyncedAt: s.updatedAt });
    n++;
  }
  return n;
}

/** Rebuild a local session (+ coarse samples and notes) from a Pulse workouts row. */
export function sessionFromRow(row, settings = {}) {
  const j = row.polar_json || {};
  const ss = j.session || {};
  const startedAt = Date.parse(row.started_at || ss.started_at);
  const endedAt = row.ended_at || ss.ended_at ? Date.parse(row.ended_at || ss.ended_at) : null;
  const zones = (row.zones_json || j.zones)?.zones?.map((z) => z.seconds) || [0, 0, 0, 0, 0];
  const trace = row.hr_trace_json || j.hr_trace || { points: [] };
  const updated = Date.parse(row.updated_at) || Date.now();
  const session = {
    id: row.log_id, startedAt, endedAt, status: 'complete', type: ss.type || null,
    kind: KINDS.includes(row.kind) ? row.kind : null, revision: row.revision || 1,
    source: ss.source || 'ble', device: ss.device ? { name: ss.device } : null,
    laps: (ss.laps || []).filter((l) => l.lap > 1).map((l) => ({ n: l.lap, t: startedAt + l.start_s * 1000, elapsed_s: l.start_s })),
    pauses: [], gaps: (ss.gaps || []).map((g) => ({ start: startedAt + g.start_s * 1000, end: startedAt + g.end_s * 1000, startElapsed: g.start_s, endElapsed: g.end_s })),
    durationS: row.duration_s ?? ss.duration_s ?? 0,
    summary: { avg: row.avg_hr, max: row.max_hr, min: row.min_hr, calories: row.calories_kcal, zones },
    updatedAt: updated, cloudSyncedAt: updated, fromCloud: true, schema: 1,
  };
  const samples = (trace.points || []).map(([t, hr], i) => ({
    sessionId: row.log_id, seq: i, t: startedAt + t * 1000, elapsed_s: t, hr: Math.round(hr), rr_ms: [], lap: null,
  }));
  const text = row.notes_raw ?? j.notes?.text ?? '';
  const notes = text ? { sessionId: row.log_id, text, parsed: parseNotes(text, { unit: settings.weightUnit === 'kg' ? 'kg' : 'lb' }), updatedAt: updated } : null;
  return { session, samples, notes };
}

async function pull(c) {
  const since = localStorage.getItem(LAST_PULL_KEY) || '1970-01-01T00:00:00Z';
  const startedPull = new Date().toISOString();
  const { data: rows, error } = await c.from('workouts').select('*')
    .eq('source', 'pulse').not('log_id', 'is', null).gt('updated_at', since).order('updated_at').limit(1000);
  if (error) throw error;
  let n = 0;
  for (const row of rows || []) {
    const local = await db.get('sessions', row.log_id);
    if (row.deleted_at) { if (local) { await db.deleteSessionLocal(row.log_id); n++; } continue; }
    if (local) {
      // Same workout already here: adopt a newer revision's kind (e.g. edited on another device).
      if ((row.revision || 1) > (local.revision || 1) && KINDS.includes(row.kind)) {
        await db.put('sessions', { ...local, kind: row.kind, revision: row.revision, cloudSyncedAt: local.updatedAt });
        n++;
      }
      continue;
    }
    const { session, samples, notes } = sessionFromRow(row, getSettings());
    if (!Number.isFinite(session.startedAt)) continue;
    await db.putMany('samples', samples);
    if (notes) await db.put('notes', notes);
    await db.put('sessions', session);
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
