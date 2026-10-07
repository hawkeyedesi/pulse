// CSV / JSON exports and full-backup import.
import * as db from './db.js';
import { exportableSettings, saveSettings } from './settings.js';

export function samplesToCsv(samples) {
  const rows = ['timestamp,elapsed_s,hr,rr_ms,lap'];
  for (const s of samples) {
    const rr = (s.rr_ms || []).join(';');
    rows.push([new Date(s.t).toISOString(), s.elapsed_s, s.hr, rr ? `"${rr}"` : '', s.lap ?? ''].join(','));
  }
  return rows.join('\n') + '\n';
}

export async function sessionBundle(sessionId) {
  const [session, samples, notes] = await Promise.all([
    db.get('sessions', sessionId), db.getSamples(sessionId), db.get('notes', sessionId),
  ]);
  return { format: 'pulse-session', version: 1, exportedAt: new Date().toISOString(), session, notes: notes || null, samples };
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function fileStem(session) {
  const d = new Date(session.startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `pulse-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${(session.type || 'workout').toLowerCase()}`;
}

export async function exportAll() {
  const [sessions, samples, notes] = await Promise.all([db.getAll('sessions'), db.getAll('samples'), db.getAll('notes')]);
  return {
    format: 'pulse-backup', version: 1, exportedAt: new Date().toISOString(),
    settings: exportableSettings(), sessions: sessions.filter((s) => !s.deleted), samples, notes,
  };
}

/** Merge a backup (or single-session export) into local storage. Returns counts. */
export async function importData(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  let sessions = [], samples = [], notes = [];
  if (data.format === 'pulse-backup') {
    ({ sessions = [], samples = [], notes = [] } = data);
    if (data.settings) {
      const { maxHr, zones, weight, weightUnit, age, sex } = data.settings;
      saveSettings(Object.fromEntries(Object.entries({ maxHr, zones, weight, weightUnit, age, sex }).filter(([, v]) => v != null)));
    }
  } else if (data.format === 'pulse-session') {
    sessions = [data.session]; samples = data.samples || []; notes = data.notes ? [data.notes] : [];
  } else {
    throw new Error('Not a Pulse export file');
  }
  sessions = sessions.filter((s) => s && s.id && s.startedAt).map((s) => ({ ...s, syncedAt: null, updatedAt: Date.now(), status: s.status === 'active' ? 'complete' : s.status }));
  samples = samples.filter((s) => s && s.sessionId && Number.isFinite(s.seq));
  notes = notes.filter((n) => n && n.sessionId);
  await db.putMany('sessions', sessions);
  for (let i = 0; i < samples.length; i += 2000) await db.putMany('samples', samples.slice(i, i + 2000));
  await db.putMany('notes', notes);
  return { sessions: sessions.length, samples: samples.length, notes: notes.length };
}
