// Builds the "PULSE WORKOUT LOG v1" message that Pulse posts into the user's OpenClaw
// coach session after each saved workout. Pure functions (no DOM / IndexedDB) so they
// can be unit-tested in Node.
//
// Message layout (plain text, one user message):
//   PULSE WORKOUT LOG v1
//   log_id: <session uuid> · revision: <n>
//   <instruction line for the coach>
//   <human summary lines>
//   ```json
//   { format: "pulse-workout-log", version: 1, ... }   <- structured data
//   ```

import { fmtDuration, zoneBpmBounds, ZONE_NAMES, lapStats, DEFAULT_SETTINGS } from './stats.js';

export const LOG_HEADER = 'PULSE WORKOUT LOG v1';
export const LOG_FORMAT = 'pulse-workout-log';
export const LOG_VERSION = 1;
export const TRACE_INTERVAL_S = 5;
const MAX_TRACE_POINTS = 4320; // 6 h at 5 s; longer sessions widen the bucket to stay compact

/** ISO 8601 in the device's local time with its UTC offset, e.g. 2026-10-07T18:12:05-07:00 */
export function isoLocal(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch { return 'local'; }
}

/**
 * Average HR into fixed buckets of active elapsed time (pauses are already excluded from
 * elapsed_s by the recorder). Empty buckets (signal gaps) are omitted.
 * @returns {{interval_s:number, points:Array<[number, number]>}} points are [t_s, avg_hr]
 */
export function downsampleHr(samples, intervalS = TRACE_INTERVAL_S, maxPoints = MAX_TRACE_POINTS) {
  const valid = (samples || []).filter((s) => s && s.hr > 0 && Number.isFinite(s.elapsed_s));
  if (!valid.length) return { interval_s: intervalS, points: [] };
  const span = Math.max(...valid.map((s) => s.elapsed_s));
  let interval = intervalS;
  while (span / interval > maxPoints) interval *= 2;
  const buckets = new Map();
  for (const s of valid) {
    const k = Math.floor(s.elapsed_s / interval);
    const b = buckets.get(k) || { sum: 0, n: 0 };
    b.sum += s.hr; b.n++;
    buckets.set(k, b);
  }
  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, b]) => [k * interval, Math.round((b.sum / b.n) * 10) / 10]);
  return { interval_s: interval, points };
}

/**
 * Whole-session RR summary (not raw RR). Intervals outside 300–2000 ms are dropped; a
 * successive difference is used only when both beats are adjacent (no pause/gap between
 * packets) and differ by <= 20 % (simple artifact rejection).
 * @returns {null | {rr_count, rejected, mean_rr_ms, mean_hr_from_rr, sdnn_ms, rmssd_ms, pnn50_pct}}
 */
export function rrSummary(samples, { minCount = 20 } = {}) {
  const rr = [];
  let rejected = 0;
  let prevT = null;
  let chain = []; // successive diffs only within an unbroken chain
  const diffs = [];
  const flush = () => { chain = []; };
  for (const s of samples || []) {
    const list = s?.rr_ms || [];
    if (prevT != null && s.t - prevT > 3000) flush();
    prevT = s.t;
    for (const v of list) {
      if (!(v >= 300 && v <= 2000)) { rejected++; flush(); continue; }
      const last = chain[chain.length - 1];
      if (last != null) {
        if (Math.abs(v - last) > last * 0.2) { rejected++; flush(); continue; }
        diffs.push(v - last);
      }
      chain.push(v);
      rr.push(v);
    }
  }
  if (rr.length < minCount) return null;
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  const sdnn = Math.sqrt(rr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rr.length - 1));
  const rmssd = diffs.length ? Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / diffs.length) : null;
  const pnn50 = diffs.length ? (diffs.filter((d) => Math.abs(d) > 50).length / diffs.length) * 100 : null;
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    rr_count: rr.length, rejected, mean_rr_ms: r1(mean), mean_hr_from_rr: r1(60000 / mean),
    sdnn_ms: r1(sdnn), rmssd_ms: r1(rmssd), pnn50_pct: r1(pnn50),
  };
}

function zoneTable(summary, settings) {
  const secs = summary?.zones || [0, 0, 0, 0, 0];
  const total = secs.reduce((a, b) => a + b, 0);
  const maxHr = settings.maxHr || DEFAULT_SETTINGS.maxHr;
  const b = zoneBpmBounds(maxHr, settings.zones || DEFAULT_SETTINGS.zones);
  const lo = [null, ...b];
  const hi = [...b.map((x) => x - 1), null];
  return {
    total_s: Math.round(total),
    zones: secs.map((s, i) => ({
      zone: i + 1, name: ZONE_NAMES[i], min_bpm: lo[i], max_bpm: hi[i],
      seconds: Math.round(s), pct: total ? Math.round((s / total) * 1000) / 10 : 0,
    })),
  };
}

function notesFields(notes) {
  if (!notes) return null;
  const p = notes.parsed || {};
  return {
    text: (notes.text || '').trim(),
    fields: {
      type: p.type ?? null, focus: p.focus ?? null,
      exercises: (p.exercises || []).map((e) => ({ ...e })),
      effort: p.effort ?? null, energy: p.energy ?? null, sleep_hours: p.sleepHours ?? null,
      distance: p.distance ?? null, flags: (p.flags || []).map((f) => f.label),
    },
    labels: (p.chips || []).map((c) => c.label),
  };
}

function pausedSeconds(session) {
  return Math.round((session.pauses || []).reduce((a, p) => a + Math.max(0, (p.end ?? p.start) - p.start), 0) / 1000);
}

/** Structured JSON part of the log. */
export function workoutLogData(session, notes, samples, settings, { revision = 1, now = Date.now() } = {}) {
  const s = session.summary || {};
  const laps = lapStats(samples || [], session.laps || []);
  const n = notesFields(notes);
  return {
    format: LOG_FORMAT,
    version: LOG_VERSION,
    log_id: session.id,
    revision,
    generated_at: isoLocal(now),
    session: {
      id: session.id,
      type: session.type || n?.fields.type || null,
      source: session.source || 'ble',
      device: session.device?.name || null,
      timezone: localTimeZone(),
      started_at: isoLocal(session.startedAt),
      ended_at: session.endedAt ? isoLocal(session.endedAt) : null,
      duration_s: Math.round(session.durationS || 0),
      paused_s: pausedSeconds(session),
      avg_hr: s.avg ?? null, max_hr: s.max ?? null, min_hr: s.min ?? null,
      calories_kcal: s.calories ?? null,
      calories_method: s.calories != null ? 'HR-based estimate (Keytel 2005)' : null,
      max_hr_setting: settings.maxHr ?? null,
      laps: laps.map((l) => ({ lap: l.lap, start_s: l.startS, duration_s: l.durationS, avg_hr: l.avg, max_hr: l.max })),
      gaps: (session.gaps || []).filter((g) => g.startElapsed != null)
        .map((g) => ({ start_s: g.startElapsed, end_s: g.endElapsed ?? g.startElapsed })),
      sample_count: (samples || []).length,
    },
    zones: zoneTable(s, settings),
    notes: n,
    hrv: rrSummary(samples),
    hr_trace: (() => {
      const d = downsampleHr(samples);
      return { interval_s: d.interval_s, aggregation: 'mean', time_base: 'active elapsed seconds (pauses excluded)', columns: ['t_s', 'hr'], points: d.points };
    })(),
  };
}

function humanSummary(data, settings) {
  const ss = data.session;
  const start = new Date(Date.parse(ss.started_at));
  const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  const tOpts = { hour: 'numeric', minute: '2-digit' };
  let when = `${start.toLocaleDateString('en-US', opts)}, ${start.toLocaleTimeString('en-US', tOpts)}`;
  if (ss.ended_at) when += ` – ${new Date(Date.parse(ss.ended_at)).toLocaleTimeString('en-US', { ...tOpts, timeZoneName: 'short' })}`;
  when += ` (${ss.timezone})`;
  const lines = [];
  lines.push(`- When: ${when}`);
  lines.push(`- Type: ${ss.type || 'Unspecified'}`);
  lines.push(`- Duration: ${fmtDuration(ss.duration_s)} active${ss.paused_s ? ` (paused ${fmtDuration(ss.paused_s)})` : ''}`);
  lines.push(`- Heart rate: avg ${ss.avg_hr ?? '–'} bpm, max ${ss.max_hr ?? '–'} bpm, min ${ss.min_hr ?? '–'} bpm (max HR setting ${ss.max_hr_setting ?? settings.maxHr})`);
  lines.push('- Time in zones: ' + data.zones.zones.map((z) => {
    const range = z.min_bpm == null ? `<${z.max_bpm + 1}` : z.max_bpm == null ? `${z.min_bpm}+` : `${z.min_bpm}–${z.max_bpm}`;
    return `Z${z.zone} ${z.name} (${range} bpm) ${fmtDuration(z.seconds)} ${Math.round(z.pct)}%`;
  }).join(' · '));
  if (ss.calories_kcal != null) lines.push(`- Calories: ~${ss.calories_kcal} kcal (heart-rate estimate)`);
  if (ss.laps.length) lines.push(`- Laps/sets (${ss.laps.length}): ` + ss.laps.map((l) => `#${l.lap} ${fmtDuration(l.duration_s)} avg ${l.avg_hr} max ${l.max_hr}`).join('; '));
  if (ss.gaps.length) lines.push(`- Signal gaps: ${ss.gaps.length} (${fmtDuration(ss.gaps.reduce((a, g) => a + (g.end_s - g.start_s), 0))} total)`);
  if (data.hrv) lines.push(`- RR/HRV (whole session, exercise conditions): RMSSD ${data.hrv.rmssd_ms ?? '–'} ms, SDNN ${data.hrv.sdnn_ms} ms, pNN50 ${data.hrv.pnn50_pct ?? '–'}%, ${data.hrv.rr_count} beats`);
  const n = data.notes;
  if (n) {
    const f = n.fields;
    const parts = [];
    if (f.focus) parts.push(`focus ${f.focus}`);
    if (f.exercises.length) parts.push(`exercises: ${f.exercises.map((e) => e.label).join(', ')}`);
    if (f.distance) parts.push(`distance ${f.distance.label}`);
    if (f.effort != null) parts.push(`effort ${f.effort}/10`);
    if (f.energy != null) parts.push(`energy ${f.energy}/10`);
    if (f.sleep_hours != null) parts.push(`sleep ~${f.sleep_hours} h`);
    if (f.flags.length) parts.push(`flags: ${f.flags.join(', ')}`);
    lines.push(`- Notes (parsed): ${parts.join(' · ') || 'nothing recognized'}`);
    lines.push(`- Notes (raw): ${n.text ? `"${n.text.replace(/\s+/g, ' ')}"` : '(none)'}`);
  } else {
    lines.push('- Notes: none');
  }
  return lines.join('\n');
}

export function coachInstruction(data) {
  const day = data.session.started_at.slice(0, 10);
  return `Coach: please save this workout to your workspace training log (for example append a summary entry to fitness/workouts.md and store the JSON below as fitness/workouts/${day}-${data.log_id.slice(0, 8)}.json). `
    + `Use log_id to avoid duplicates: if this log_id is already saved, update that entry instead of adding a new one. `
    + 'Then reply with a 2–3 sentence takeaway for me.';
}

/**
 * Build the full message.
 * @returns {{text:string, summary:string, data:object}} text is what gets posted; summary is
 *   the human part (used as the visible chat bubble in Pulse).
 */
export function buildWorkoutLog(session, notes, samples, settings, opts = {}) {
  const data = workoutLogData(session, notes, samples, settings, opts);
  const summary = humanSummary(data, settings);
  const head = `${LOG_HEADER}\nlog_id: ${data.log_id} · revision: ${data.revision}`;
  const text = `${head}\n\n${coachInstruction(data)}\n\nSummary\n${summary}\n\nData\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n`;
  return { text, summary: `${LOG_HEADER}\n${summary}`, data };
}

/** Parse a log message back (used by tests and handy for debugging). */
export function parseWorkoutLog(text) {
  if (!String(text).startsWith(LOG_HEADER)) return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  return m ? JSON.parse(m[1]) : null;
}
