// Workout recorder: owns the active session, writes every sample to IndexedDB as it
// arrives (crash-safe), tracks laps, pauses and signal gaps, and keeps live stats.

import * as db from './db.js';
import { StatsAccumulator, summarizeSamples } from './stats.js';

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const LIVE_WINDOW_S = 300;

export class Recorder extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.session = null;
    this.seq = 0;
    this.lapNo = 1;
    this.acc = new StatsAccumulator(settings);
    this.window = []; // last 5 minutes for the live chart: {x: elapsed_s, y: hr}
    this.lastHr = null;
    this.metaTimer = null;
    this.writeChain = Promise.resolve();
  }

  get active() { return !!this.session && this.session.status === 'active'; }
  get paused() { return !!this.session?.pauses.find((p) => p.end == null); }

  /** Active (non-paused) elapsed milliseconds. */
  elapsedMs(now = Date.now()) {
    if (!this.session) return 0;
    const end = this.session.endedAt || now;
    let paused = 0;
    for (const p of this.session.pauses) paused += (p.end ?? end) - p.start;
    return Math.max(0, end - this.session.startedAt - paused);
  }

  async start({ type = null, device = null, source = 'ble' } = {}) {
    const now = Date.now();
    this.session = {
      id: uuid(), startedAt: now, endedAt: null, status: 'active', type, source,
      device, laps: [], pauses: [], gaps: [], durationS: 0, summary: null,
      lastSampleAt: null, updatedAt: now, syncedAt: null, schema: 1,
    };
    this.seq = 0; this.lapNo = 1; this.window = []; this.acc = new StatsAccumulator(this.settings);
    await db.put('sessions', this.session);
    this._startMetaTimer();
    this._emit();
    return this.session;
  }

  /** Re-open an unfinished session after a crash / reload. */
  async resume(session) {
    const samples = await db.getSamples(session.id);
    this.session = session;
    this.seq = samples.length ? samples[samples.length - 1].seq + 1 : 0;
    this.lapNo = (session.laps?.length || 0) + 1;
    this.acc = new StatsAccumulator(this.settings);
    let prev = null;
    for (const s of samples) {
      const broke = prev && session.pauses.some((p) => p.start >= prev.t && p.start <= s.t);
      this.acc.add(s, { breakBefore: !!broke });
      prev = s;
    }
    this.acc.breakChain();
    // Time the app was closed counts as a pause so it doesn't inflate duration.
    const lastActivity = session.lastSampleAt || session.updatedAt || session.startedAt;
    const openPause = session.pauses.find((p) => p.end == null);
    if (!openPause) session.pauses.push({ start: lastActivity, end: Date.now(), reason: 'recovered' });
    else openPause.end = Date.now();
    const cutoff = (samples.length ? samples[samples.length - 1].elapsed_s : 0) - LIVE_WINDOW_S;
    this.window = samples.filter((s) => s.elapsed_s >= cutoff).map((s) => ({ x: s.elapsed_s, y: s.hr }));
    await this._saveMeta();
    this._startMetaTimer();
    this._emit();
  }

  addSample({ t, hr, rr = [] }) {
    if (!this.active) return;
    this.lastHr = hr;
    if (this.paused || !hr) { this._emit(); return; }
    const elapsed_s = Math.round(this.elapsedMs(t) / 100) / 10;
    const sample = { sessionId: this.session.id, seq: this.seq++, t, elapsed_s, hr, rr_ms: rr, lap: this.lapNo };
    this.acc.add(sample);
    this.session.lastSampleAt = t;
    this.window.push({ x: elapsed_s, y: hr });
    while (this.window.length && this.window[0].x < elapsed_s - LIVE_WINDOW_S) this.window.shift();
    // Persist immediately; chain writes so they land in order.
    this.writeChain = this.writeChain.then(() => db.put('samples', sample)).catch((e) => console.error('sample write failed', e));
    this._emit();
  }

  lap() {
    if (!this.active) return;
    const elapsed_s = Math.round(this.elapsedMs() / 1000);
    this.session.laps.push({ n: this.lapNo + 1, t: Date.now(), elapsed_s });
    this.lapNo++;
    this._saveMeta();
    this._emit();
    return this.lapNo;
  }

  pause() {
    if (!this.active || this.paused) return;
    this.session.pauses.push({ start: Date.now(), end: null });
    this.acc.breakChain();
    this._saveMeta(); this._emit();
  }

  resumeFromPause() {
    const p = this.session?.pauses.find((x) => x.end == null);
    if (!p) return;
    p.end = Date.now();
    this.acc.breakChain();
    this._saveMeta(); this._emit();
  }

  gapStart() {
    if (!this.active) return;
    if (this.session.gaps.find((g) => g.end == null)) return;
    this.session.gaps.push({ start: Date.now(), end: null, startElapsed: Math.round(this.elapsedMs() / 1000) });
    this.acc.breakChain();
    this._saveMeta(); this._emit();
  }

  gapEnd() {
    const g = this.session?.gaps.find((x) => x.end == null);
    if (!g) return;
    g.end = Date.now();
    g.endElapsed = Math.round(this.elapsedMs() / 1000);
    this._saveMeta(); this._emit();
  }

  liveSummary() { return this.acc.summary(); }

  /** Finish: close pauses/gaps, compute final summary from stored samples. */
  async end() {
    if (!this.session) return null;
    clearInterval(this.metaTimer);
    const now = Date.now();
    this.session.pauses.forEach((p) => { if (p.end == null) p.end = now; });
    this.gapEnd();
    await this.writeChain;
    this.session.endedAt = now;
    this.session.durationS = Math.round(this.elapsedMs(now) / 1000);
    this.session.status = 'complete';
    const samples = await db.getSamples(this.session.id);
    this.session.summary = summarizeSamples(samples, this.settings, this.session.pauses);
    this.session.updatedAt = now;
    await db.put('sessions', this.session);
    const done = this.session;
    this.session = null;
    this._emit();
    return done;
  }

  /** Finalize a recovered session without resuming it. */
  static async finalizeRecovered(session, settings) {
    const samples = await db.getSamples(session.id);
    const end = session.lastSampleAt || session.updatedAt || session.startedAt;
    session.pauses.forEach((p) => { if (p.end == null) p.end = end; });
    session.gaps.forEach((g) => { if (g.end == null) g.end = end; });
    session.endedAt = end;
    let paused = 0;
    session.pauses.forEach((p) => { paused += Math.max(0, Math.min(p.end, end) - p.start); });
    session.durationS = Math.max(0, Math.round((end - session.startedAt - paused) / 1000));
    if (samples.length) session.durationS = Math.max(session.durationS, Math.round(samples[samples.length - 1].elapsed_s));
    session.status = 'complete';
    session.summary = summarizeSamples(samples, settings, session.pauses);
    session.updatedAt = Date.now();
    await db.put('sessions', session);
    return session;
  }

  _startMetaTimer() {
    clearInterval(this.metaTimer);
    this.metaTimer = setInterval(() => this._saveMeta(), 5000);
  }

  _saveMeta() {
    if (!this.session) return Promise.resolve();
    this.session.durationS = Math.round(this.elapsedMs() / 1000);
    this.session.summary = this.acc.summary();
    this.session.updatedAt = Date.now();
    const snapshot = JSON.parse(JSON.stringify(this.session));
    this.writeChain = this.writeChain.then(() => db.put('sessions', snapshot)).catch((e) => console.error('meta write failed', e));
    return this.writeChain;
  }

  /** Flush pending writes (call on pagehide). */
  flush() { return this._saveMeta(); }

  _emit() { this.dispatchEvent(new CustomEvent('change')); }
}
