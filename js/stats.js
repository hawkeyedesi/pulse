// Pure computations: zones, calories, session summaries, trends and "patterns".

export const ZONE_NAMES = ['Warm-up', 'Easy', 'Aerobic', 'Threshold', 'Max'];
export const MAX_DT_S = 5; // never credit more than 5 s to one sample (covers dropouts)

export const DEFAULT_SETTINGS = {
  maxHr: 190,
  zones: [60, 70, 80, 90], // lower bounds (% of max HR) of Z2..Z5
  weight: 175,
  weightUnit: 'lb',
  age: 40,
  sex: 'male',
  layout: 'auto', // auto | phone | desk
  demo: false,
  supabaseUrl: '',
  supabaseAnonKey: '',
  gatewayUrl: '',
  gatewayToken: '',
  coachModel: 'openclaw/default',
  coachSessionKey: '', // x-openclaw-session-key: route every coach request into this OpenClaw session
  coachAutoSend: null, // null = automatic (on when a session key is set); true/false = user's explicit choice
};

/** Zone (1..5) for a heart rate. */
export function zoneFor(hr, maxHr = 190, thresholds = DEFAULT_SETTINGS.zones) {
  if (!hr || !maxHr) return 1;
  const pct = (hr / maxHr) * 100;
  let z = 1;
  for (let i = 0; i < thresholds.length; i++) if (pct >= thresholds[i]) z = i + 2;
  return z;
}

/** bpm boundaries: [z2Start, z3Start, z4Start, z5Start] */
export function zoneBpmBounds(maxHr = 190, thresholds = DEFAULT_SETTINGS.zones) {
  return thresholds.map((p) => Math.round((maxHr * p) / 100));
}

export function zoneRangeLabel(z, maxHr, thresholds) {
  const b = zoneBpmBounds(maxHr, thresholds);
  if (z === 1) return `< ${b[0]}`;
  if (z === 5) return `> ${b[3]}`;
  return `${b[z - 2]}–${b[z - 1]}`;
}

/**
 * Keytel et al. (2005) HR-based energy expenditure, kcal per minute.
 * Weight in kg, age in years. Returns >= 0.
 */
export function kcalPerMinute(hr, weightKg, age, sex = 'male') {
  if (!hr) return 0;
  const v = sex === 'female'
    ? (-20.4022 + 0.4472 * hr - 0.1263 * weightKg + 0.074 * age) / 4.184
    : (-55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age) / 4.184;
  return Math.max(0, v);
}

export function weightKg(settings) {
  const w = Number(settings.weight) || 75;
  return settings.weightUnit === 'kg' ? w : w * 0.45359237;
}

/** Incremental accumulator used both live and for recomputing a stored session. */
export class StatsAccumulator {
  constructor(settings) {
    this.s = settings;
    this.kg = weightKg(settings);
    this.reset();
  }
  reset() {
    this.n = 0; this.sumHrDt = 0; this.sumDt = 0; this.max = 0; this.min = Infinity;
    this.zones = [0, 0, 0, 0, 0]; this.kcal = 0; this.prevT = null;
  }
  /** @param {{t:number, hr:number}} sample  t in ms */
  add(sample, { breakBefore = false } = {}) {
    const { t, hr } = sample;
    if (!hr) { this.prevT = t; return; }
    let dt = this.prevT == null || breakBefore ? 1 : (t - this.prevT) / 1000;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_DT_S) dt = 1; // after a gap, credit a nominal second only
    this.prevT = t;
    this.n++;
    this.sumHrDt += hr * dt; this.sumDt += dt;
    if (hr > this.max) this.max = hr;
    if (hr < this.min) this.min = hr;
    this.zones[zoneFor(hr, this.s.maxHr, this.s.zones) - 1] += dt;
    this.kcal += (kcalPerMinute(hr, this.kg, Number(this.s.age) || 40, this.s.sex) * dt) / 60;
  }
  /** Call when recording pauses so paused time is not credited. */
  breakChain() { this.prevT = null; }
  summary() {
    return {
      avg: this.sumDt ? Math.round(this.sumHrDt / this.sumDt) : null,
      max: this.max || null,
      min: this.min === Infinity ? null : this.min,
      zones: this.zones.map((z) => Math.round(z)),
      calories: Math.round(this.kcal),
      samples: this.n,
    };
  }
}

/** Summarize stored samples (sorted by seq). Pauses split the chain. */
export function summarizeSamples(samples, settings, pauses = []) {
  const acc = new StatsAccumulator(settings);
  let prev = null;
  for (const smp of samples) {
    const broke = prev && pauses.some((p) => p.start >= prev.t && p.start <= smp.t);
    acc.add(smp, { breakBefore: !!broke });
    prev = smp;
  }
  return acc.summary();
}

/** Per-lap stats. laps: [{elapsed_s}], samples carry .lap (1-based). */
export function lapStats(samples, laps = []) {
  if (!laps.length) return [];
  const byLap = new Map();
  for (const s of samples) {
    if (!s.hr) continue;
    const l = s.lap || 1;
    if (!byLap.has(l)) byLap.set(l, { lap: l, n: 0, sum: 0, max: 0, start: s.elapsed_s, end: s.elapsed_s });
    const e = byLap.get(l);
    e.n++; e.sum += s.hr; e.max = Math.max(e.max, s.hr); e.end = s.elapsed_s;
  }
  return [...byLap.values()].sort((a, b) => a.lap - b.lap).map((e) => ({
    lap: e.lap, avg: Math.round(e.sum / e.n), max: e.max, startS: Math.round(e.start), durationS: Math.round(e.end - e.start),
  }));
}

// ---------------------------------------------------------------- formatting
export function fmtDuration(totalS, { long = false } = {}) {
  totalS = Math.max(0, Math.round(totalS || 0));
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (long) return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(ms, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(ms).toLocaleDateString(undefined, opts);
}

export function relativeDay(ms, now = Date.now()) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(ms); d1.setHours(0, 0, 0, 0);
  const diff = Math.round((d0 - d1) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' });
  return fmtDate(ms);
}

// ---------------------------------------------------------------- trends
export function startOfWeek(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d.getTime();
}

export const RANGES = { '4w': 28, '3m': 91, '1y': 365 };

/**
 * @param {Array} sessions completed sessions (with .summary, .durationS, .startedAt)
 * @param {Map|Object} notesById sessionId -> {parsed}
 */
export function buildTrends(sessions, notesById = {}, range = '4w', now = Date.now()) {
  const days = RANGES[range] || 28;
  const since = startOfWeek(now - (days - 1) * 86400000);
  const inRange = sessions.filter((s) => s.startedAt >= since).sort((a, b) => a.startedAt - b.startedAt);
  const getNote = (id) => (notesById instanceof Map ? notesById.get(id) : notesById[id]);

  const weeks = [];
  for (let w = since; w <= now; w += 7 * 86400000) {
    // handle DST by normalising
    const ws = startOfWeek(w + 3600000 * 12);
    if (weeks.length && weeks[weeks.length - 1].start === ws) continue;
    weeks.push({ start: ws, minutes: 0, count: 0, zones: [0, 0, 0, 0, 0] });
  }
  for (const s of inRange) {
    const ws = startOfWeek(s.startedAt);
    const wk = weeks.find((w) => w.start === ws);
    if (!wk) continue;
    wk.minutes += (s.durationS || 0) / 60;
    wk.count++;
    (s.summary?.zones || []).forEach((z, i) => { wk.zones[i] += z / 60; });
  }
  const thisWeek = startOfWeek(now);
  const workoutsThisWeek = sessions.filter((s) => s.startedAt >= thisWeek).length;
  const totalS = inRange.reduce((a, s) => a + (s.durationS || 0), 0);
  const withAvg = inRange.filter((s) => s.summary?.avg);
  const avgSessionHr = withAvg.length
    ? Math.round(withAvg.reduce((a, s) => a + s.summary.avg, 0) / withAvg.length) : null;

  const perSession = inRange.map((s) => ({
    id: s.id, t: s.startedAt, avg: s.summary?.avg ?? null, max: s.summary?.max ?? null,
    type: s.type, durationS: s.durationS, effort: getNote(s.id)?.parsed?.effort ?? null,
  }));

  return {
    since, weeks, workoutsThisWeek, totalS, avgSessionHr, count: inRange.length, perSession,
    effortPoints: perSession.filter((p) => p.effort != null && p.avg != null),
  };
}

/** Simple computed insights. Returns an array of strings. */
export function computePatterns(sessions, notesById = {}, now = Date.now()) {
  const out = [];
  const getNote = (id) => (notesById instanceof Map ? notesById.get(id) : notesById[id]);
  const done = sessions.filter((s) => s.summary?.avg).sort((a, b) => a.startedAt - b.startedAt);
  if (done.length < 3) return out;

  // 1. Sleep vs average HR, per workout type
  const byType = {};
  for (const s of done) {
    const sleep = getNote(s.id)?.parsed?.sleepHours;
    if (sleep == null) continue;
    (byType[s.type || 'Other'] ||= { low: [], ok: [] })[sleep < 6 ? 'low' : 'ok'].push(s.summary.avg);
  }
  for (const [type, g] of Object.entries(byType)) {
    if (g.low.length >= 2 && g.ok.length >= 2) {
      const d = Math.round(mean(g.low) - mean(g.ok));
      if (Math.abs(d) >= 3) {
        out.push(`Your ${type} sessions average ${Math.abs(d)} bpm ${d > 0 ? 'higher' : 'lower'} when you slept under 6 h (${g.low.length} vs ${g.ok.length} sessions).`);
      }
    }
  }

  // 2. Recurring flags in the last 14 days
  const since14 = now - 14 * 86400000;
  const flagCounts = {};
  for (const s of done.filter((x) => x.startedAt >= since14)) {
    for (const f of getNote(s.id)?.parsed?.flags || []) flagCounts[f.label] = (flagCounts[f.label] || 0) + 1;
  }
  for (const [label, n] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    if (n >= 2) out.push(`${label.charAt(0).toUpperCase() + label.slice(1).toLowerCase()} mentioned ${n} times in the last 2 weeks.`);
  }

  // 3. Hard-zone time, last 28 days vs the 28 before
  const d28 = 28 * 86400000;
  const hard = (from, to) => done.filter((s) => s.startedAt >= from && s.startedAt < to)
    .reduce((a, s) => a + (s.summary.zones?.[3] || 0) + (s.summary.zones?.[4] || 0), 0);
  const cur = hard(now - d28, now + 1);
  const prev = hard(now - 2 * d28, now - d28);
  if (prev > 120 && cur > 0) {
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (Math.abs(pct) >= 10) out.push(`Z4–Z5 time is ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% vs the previous 4 weeks.`);
  }

  // 4. Lift progression
  const lifts = {};
  for (const s of done) {
    for (const e of getNote(s.id)?.parsed?.exercises || []) {
      if (e.weight) (lifts[e.name] ||= []).push({ t: s.startedAt, w: e.weight, unit: e.unit });
    }
  }
  for (const [name, arr] of Object.entries(lifts)) {
    if (arr.length >= 2) {
      const first = arr[0]; const last = arr[arr.length - 1];
      if (last.w > first.w && last.unit === first.unit) {
        out.push(`${name} up from ${first.w} to ${last.w} ${last.unit} since ${fmtDate(first.t, { month: 'short', day: 'numeric' })}.`);
        break;
      }
    }
  }

  // 5. Consistency
  const weeks4 = done.filter((s) => s.startedAt >= now - d28).length;
  if (weeks4 >= 4) out.push(`${(weeks4 / 4).toFixed(1)} workouts per week over the last 4 weeks.`);

  // 6. Average HR drift for the most common type
  const counts = {};
  done.forEach((s) => { counts[s.type || 'Other'] = (counts[s.type || 'Other'] || 0) + 1; });
  const [topType, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  if (topN >= 6) {
    const arr = done.filter((s) => (s.type || 'Other') === topType);
    const half = Math.floor(arr.length / 2);
    const d = Math.round(mean(arr.slice(half).map((s) => s.summary.avg)) - mean(arr.slice(0, half).map((s) => s.summary.avg)));
    if (Math.abs(d) >= 3) out.push(`Average HR in recent ${topType} sessions is ${Math.abs(d)} bpm ${d > 0 ? 'higher' : 'lower'} than in earlier ones.`);
  }
  return out.slice(0, 5);
}

function mean(a) { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }
