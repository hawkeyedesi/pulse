// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRateMeasurement, encodeHeartRateMeasurement, parseBatteryLevel } from '../js/hr-parse.js';
import { parseNotes, wordsToNumbers } from '../js/notes-parser.js';
import { zoneFor, zoneBpmBounds, StatsAccumulator, kcalPerMinute, buildTrends, summarizeSamples } from '../js/stats.js';
import {
  readSse, buildMessages, sendChat, sendToSession, coachHeaders, sessionKeyIssue, autoSendEnabled, SESSION_KEY_HEADER,
} from '../js/coach.js';
import { downsampleHr, rrSummary, buildWorkoutLog, parseWorkoutLog, LOG_HEADER } from '../js/workout-log.js';
import { createCoachSync } from '../js/coach-sync.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 0x2A37
test('HR: 8-bit value, no contact feature', () => {
  const r = parseHeartRateMeasurement([0x00, 72]);
  assert.equal(r.hr, 72);
  assert.equal(r.contactSupported, false);
  assert.equal(r.contactDetected, null);
  assert.equal(r.energyExpended, null);
  assert.deepEqual(r.rr, []);
});

test('HR: Polar-style 8-bit + contact + one RR interval', () => {
  // flags 0x16 = RR present | contact supported | contact detected
  // RR raw 0x0340 = 832/1024 s = 812.5 ms -> 813
  const r = parseHeartRateMeasurement(Uint8Array.from([0x16, 0x4a, 0x40, 0x03]));
  assert.equal(r.hr, 74);
  assert.equal(r.contactSupported, true);
  assert.equal(r.contactDetected, true);
  assert.deepEqual(r.rrRaw, [832]);
  assert.deepEqual(r.rr, [813]);
});

test('HR: 16-bit value', () => {
  const r = parseHeartRateMeasurement([0x01, 0x2c, 0x01]); // 300 bpm (format test)
  assert.equal(r.hr, 300);
});

test('HR: 16-bit + energy expended + two RR intervals', () => {
  // flags 0x19 = 16-bit | energy | RR ; hr 150 ; energy 0x0102=258 kJ ; RR 410 (=400.4ms) and 1024 (=1000ms)
  const r = parseHeartRateMeasurement([0x19, 150, 0x00, 0x02, 0x01, 0x9a, 0x01, 0x00, 0x04]);
  assert.equal(r.hr, 150);
  assert.equal(r.energyExpended, 258);
  assert.deepEqual(r.rrRaw, [410, 1024]);
  assert.deepEqual(r.rr, [400, 1000]);
});

test('HR: contact supported but not detected', () => {
  const r = parseHeartRateMeasurement([0x04, 0]);
  assert.equal(r.contactSupported, true);
  assert.equal(r.contactDetected, false);
  assert.equal(r.hr, 0);
});

test('HR: trailing odd byte in RR list is ignored; DataView input works', () => {
  const dv = new DataView(Uint8Array.from([0x10, 60, 0x00, 0x04, 0x07]).buffer);
  const r = parseHeartRateMeasurement(dv);
  assert.deepEqual(r.rr, [1000]);
});

test('HR: too-short packet throws', () => {
  assert.throws(() => parseHeartRateMeasurement([0x00]), RangeError);
  assert.throws(() => parseHeartRateMeasurement([0x01, 0x10]), RangeError);
});

test('HR: encode/decode round trip (used by demo strap)', () => {
  const dv = encodeHeartRateMeasurement({ hr: 141, rr: [425, 431], energy: 12 });
  const r = parseHeartRateMeasurement(dv);
  assert.equal(r.hr, 141);
  assert.equal(r.energyExpended, 12);
  assert.deepEqual(r.rr, [425, 431]);
});

test('Battery level', () => {
  assert.equal(parseBatteryLevel([82]), 82);
  assert.equal(parseBatteryLevel([255]), 100);
});

// ---------------------------------------------------------------- notes
const labels = (t, o) => parseNotes(t, o).chips.map((c) => c.label);

test('Notes: mockup sentence', () => {
  const p = parseNotes('Upper body day. Bench 4 sets of 8 at 155, felt strong. Pull-ups 3 by 10. Shoulders tight on the last set. Energy 7 out of 10, slept about 6 hours.');
  assert.equal(p.type, 'Strength');
  assert.equal(p.focus, 'Upper body');
  assert.deepEqual(p.exercises.map((e) => e.label), ['Bench press 4×8 @155 lb', 'Pull-ups 3×10']);
  assert.equal(p.energy, 7);
  assert.equal(p.sleepHours, 6);
  assert.deepEqual(p.flags.map((f) => f.label), ['Shoulder tightness']);
});

test('Notes: "bench 4 sets of 8 at 155" -> Bench press 4×8 @155 lb', () => {
  assert.ok(labels('bench 4 sets of 8 at 155').includes('Bench press 4×8 @155 lb'));
});

test('Notes: spoken numbers, kg, effort, half hours, soreness', () => {
  const p = parseNotes('Leg day. Squats five sets of five at 100 kg. Romanian deadlifts three by ten. Effort 8 out of 10. Left knee a bit sore. Slept six and a half hours.');
  assert.deepEqual(p.exercises.map((e) => e.label), ['Squat 5×5 @100 kg', 'Romanian deadlift 3×10']);
  assert.equal(p.effort, 8);
  assert.equal(p.sleepHours, 6.5);
  assert.deepEqual(p.flags.map((f) => f.label), ['Knee soreness']);
});

test('Notes: "3 by 10", "7 out of 10" effort without keyword, x notation, @ weight', () => {
  const p = parseNotes('Rows 3 by 10, curls 3x12 @ 30. Felt like a 7 out of 10.');
  assert.deepEqual(p.exercises.map((e) => e.label), ['Row 3×10', 'Bicep curls 3×12 @30 lb']);
  assert.equal(p.effort, 7);
});

test('Notes: run with distance and RPE; negated pain is not a flag', () => {
  const p = parseNotes('Easy run, 5k on the treadmill, no pain, RPE 4. Slept 7 hours.');
  assert.equal(p.type, 'Run');
  assert.equal(p.distance.label, '5 km');
  assert.equal(p.effort, 4);
  assert.equal(p.sleepHours, 7);
  assert.equal(p.flags.length, 0);
});

test('Notes: spoken weight "one fifty five"', () => {
  assert.equal(wordsToNumbers('bench at one fifty five'), 'bench at 155');
  assert.ok(labels('bench four sets of eight at one fifty five').includes('Bench press 4×8 @155 lb'));
});

test('Notes: empty input', () => {
  assert.deepEqual(parseNotes('').chips, []);
});

// ---------------------------------------------------------------- stats
test('Zones with default thresholds and max 190', () => {
  assert.deepEqual(zoneBpmBounds(190), [114, 133, 152, 171]);
  assert.equal(zoneFor(100, 190), 1);
  assert.equal(zoneFor(114, 190), 2);
  assert.equal(zoneFor(140, 190), 3);
  assert.equal(zoneFor(160, 190), 4);
  assert.equal(zoneFor(180, 190), 5);
});

test('Stats accumulator: time-weighted avg, zone seconds, gaps capped', () => {
  const acc = new StatsAccumulator({ maxHr: 190, zones: [60, 70, 80, 90], weight: 80, weightUnit: 'kg', age: 40, sex: 'male' });
  const t0 = 1_000_000;
  for (let i = 0; i < 60; i++) acc.add({ t: t0 + i * 1000, hr: 120 });
  acc.add({ t: t0 + 60_000 + 30_000, hr: 160 }); // 30 s dropout -> nominal 1 s
  const s = acc.summary();
  assert.equal(s.max, 160);
  assert.equal(s.min, 120);
  assert.equal(s.zones[1], 60); // 60 s in Z2 (incl. first sample nominal 1s)
  assert.equal(s.zones[3], 1);
  assert.ok(s.calories > 5 && s.calories < 20, `calories ${s.calories}`);
  assert.ok(kcalPerMinute(150, 80, 40, 'male') > 10);
});

test('summarizeSamples splits at pauses', () => {
  const samples = [{ t: 0, hr: 100 }, { t: 1000, hr: 100 }, { t: 4000, hr: 100 }];
  const s = summarizeSamples(samples, { maxHr: 190, zones: [60, 70, 80, 90], weight: 175, weightUnit: 'lb', age: 40 }, [{ start: 1500, end: 3500 }]);
  assert.equal(s.zones[0], 3); // 1 + 1 + 1 (pause break credits nominal 1 s)
});

test('Trends: weekly buckets and this-week count', () => {
  const now = Date.parse('2026-10-07T12:00:00');
  const mk = (iso, mins, avg) => ({ id: iso, startedAt: Date.parse(iso), durationS: mins * 60, status: 'complete', summary: { avg, zones: [60, 60, 60, 0, 0] } });
  const tr = buildTrends([mk('2026-10-06T18:00:00', 40, 130), mk('2026-09-29T18:00:00', 30, 120), mk('2026-08-01T18:00:00', 30, 120)], {}, '4w', now);
  assert.equal(tr.workoutsThisWeek, 1);
  assert.equal(tr.count, 2);
  assert.equal(tr.avgSessionHr, 125);
  assert.equal(Math.round(tr.weeks.at(-1).minutes), 40);
});

// ---------------------------------------------------------------- coach SSE
test('Coach: SSE stream parsing incl. split chunks and [DONE]', async () => {
  const enc = new TextEncoder();
  const parts = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Nice "}}]}\n\ndata: {"choi',
    'ces":[{"delta":{"content":"work."}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const body = new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); } });
  const deltas = [];
  const full = await readSse(body, (d) => deltas.push(d));
  assert.equal(full, 'Nice work.');
  assert.deepEqual(deltas, ['Nice ', 'work.']);
});

test('Coach: SSE error object surfaces as error', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('data: {"error":{"message":"agent timeout"}}\n\ndata: [DONE]\n\n')); c.close(); } });
  await assert.rejects(() => readSse(body), /agent timeout/);
});

test('Coach: messages start with one system context message', () => {
  const m = buildMessages({ sessionText: 'Type: Strength', trendText: 'Recent trend', history: [{ role: 'user', content: 'hi', at: 1 }] });
  assert.equal(m[0].role, 'system');
  assert.match(m[0].content, /Type: Strength/);
  assert.deepEqual(m[1], { role: 'user', content: 'hi' });
});

// ---------------------------------------------------------------- coach session routing
const COACH = { gatewayUrl: 'https://coach.test/', gatewayToken: ' tok ', coachModel: 'openclaw/default' };

function mockFetch(responder) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body || '{}') }); return responder(url, init); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const sseResponse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('Coach headers: session key only when set; reserved prefixes flagged', () => {
  assert.equal(coachHeaders(COACH)[SESSION_KEY_HEADER], undefined);
  assert.equal(coachHeaders({ ...COACH, coachSessionKey: '   ' })[SESSION_KEY_HEADER], undefined);
  const h = coachHeaders({ ...COACH, coachSessionKey: ' agent:main:telegram:dm:42 ' });
  assert.equal(h[SESSION_KEY_HEADER], 'agent:main:telegram:dm:42');
  assert.equal(h.Authorization, 'Bearer tok');
  assert.match(sessionKeyIssue('cron:nightly'), /reserved/);
  assert.match(sessionKeyIssue('SubAgent:x'), /reserved/);
  assert.match(sessionKeyIssue('acp:x'), /reserved/);
  assert.equal(sessionKeyIssue('agent:main:telegram:dm:42'), '');
});

test('Coach: streaming chat sends x-openclaw-session-key and keeps SSE + context', async () => {
  const m = mockFetch(() => sseResponse('Hi there'));
  try {
    const msgs = buildMessages({ sessionText: 'Type: Run', trendText: '', history: [{ role: 'user', content: 'yo' }] });
    const out = await sendChat({ ...COACH, coachSessionKey: 'agent:main:tg:1' }, msgs);
    assert.equal(out, 'Hi there');
    const c = m.calls[0];
    assert.equal(c.url, 'https://coach.test/v1/chat/completions');
    assert.equal(c.init.headers[SESSION_KEY_HEADER], 'agent:main:tg:1');
    assert.equal(c.body.stream, true);
    assert.equal(c.body.messages[0].role, 'system');
    assert.match(c.body.messages[0].content, /Type: Run/);
    // no key -> header absent
    await sendChat(COACH, msgs);
    assert.ok(!(SESSION_KEY_HEADER in m.calls[1].init.headers));
  } finally { m.restore(); }
});

test('Coach: sendToSession posts one non-streaming user message into the session', async () => {
  const m = mockFetch(() => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Logged. Nice work.' } }] }));
  try {
    const reply = await sendToSession({ ...COACH, coachSessionKey: 'agent:main:tg:1' }, 'PULSE WORKOUT LOG v1\n...');
    assert.equal(reply, 'Logged. Nice work.');
    const c = m.calls[0];
    assert.equal(c.body.stream, false);
    assert.equal(c.body.model, 'openclaw/default');
    assert.deepEqual(c.body.messages, [{ role: 'user', content: 'PULSE WORKOUT LOG v1\n...' }]);
    assert.equal(c.init.headers[SESSION_KEY_HEADER], 'agent:main:tg:1');
    assert.equal(c.init.headers.Accept, 'application/json');
  } finally { m.restore(); }
});

test('Coach: sendToSession surfaces a 400 for a reserved session key', async () => {
  const m = mockFetch(() => jsonResponse({ error: { message: 'invalid session key', type: 'invalid_request_error' } }, 400));
  try {
    await assert.rejects(() => sendToSession({ ...COACH, coachSessionKey: 'cron:x' }, 'x'), /Coach error 400: invalid session key.*session key in Settings/);
  } finally { m.restore(); }
});

test('Coach: sendToSession times out instead of hanging', async () => {
  const m = mockFetch((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  try {
    await assert.rejects(() => sendToSession(COACH, 'x', { timeoutMs: 50 }), /did not answer within/);
  } finally { m.restore(); }
});

test('Auto-send default: on with a session key, explicit choice wins, off without coach', () => {
  assert.equal(autoSendEnabled({ ...COACH }), false);
  assert.equal(autoSendEnabled({ ...COACH, coachSessionKey: 'k' }), true);
  assert.equal(autoSendEnabled({ ...COACH, coachSessionKey: 'k', coachAutoSend: false }), false);
  assert.equal(autoSendEnabled({ ...COACH, coachAutoSend: true }), true);
  assert.equal(autoSendEnabled({ coachSessionKey: 'k', coachAutoSend: true }), false);
});

// ---------------------------------------------------------------- workout log payload
const SETTINGS = { maxHr: 190, zones: [60, 70, 80, 90], weight: 175, weightUnit: 'lb', age: 40, sex: 'male' };

function fakeWorkout({ seconds = 600, hr = (i) => 120 + (i % 10), rr = true } = {}) {
  const t0 = Date.parse('2026-10-07T18:00:00Z');
  const samples = [];
  for (let i = 0; i < seconds; i++) {
    if (i >= 100 && i < 112) continue; // 12 s signal gap
    const h = hr(i);
    samples.push({ sessionId: 's1', seq: samples.length, t: t0 + i * 1000, elapsed_s: i, hr: h, rr_ms: rr ? [Math.round(60000 / h)] : [], lap: i < 300 ? 1 : 2 });
  }
  const session = {
    id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', startedAt: t0, endedAt: t0 + seconds * 1000 + 60000, status: 'complete', type: 'Strength', source: 'ble',
    device: { name: 'Polar H10 ABC' }, laps: [{ n: 2, t: t0 + 300000, elapsed_s: 300 }], pauses: [{ start: t0 + 400000, end: t0 + 460000 }],
    gaps: [{ start: t0 + 100000, end: t0 + 112000, startElapsed: 100, endElapsed: 112 }], durationS: seconds,
    summary: summarizeSamples(samples, SETTINGS),
  };
  const notes = { sessionId: session.id, text: 'Upper body day. Bench 4 sets of 8 at 155. Shoulders tight. Effort 7 out of 10, slept about 6 hours.' };
  notes.parsed = parseNotes(notes.text);
  return { session, notes, samples };
}

test('Downsample: 5-second means, empty buckets (gaps) omitted, zero HR ignored', () => {
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ elapsed_s: i, hr: i < 5 ? 100 : i < 10 ? 110 : 0 });
  samples.push({ elapsed_s: 25.4, hr: 130 }, { elapsed_s: 27, hr: 131 });
  const d = downsampleHr(samples);
  assert.equal(d.interval_s, 5);
  assert.deepEqual(d.points, [[0, 100], [5, 110], [25, 130.5]]);
  assert.deepEqual(downsampleHr([]).points, []);
});

test('Downsample: very long sessions widen the bucket to stay compact', () => {
  const samples = Array.from({ length: 50000 }, (_, i) => ({ elapsed_s: i, hr: 120 }));
  const d = downsampleHr(samples);
  assert.equal(d.interval_s, 20);
  assert.ok(d.points.length <= 4320);
});

test('RR summary: RMSSD/SDNN/pNN50 with artifact rejection; null when too few beats', () => {
  const rr = [800, 810, 790, 805, 795, 2500, 800, 860, 800, 805, 798, 802, 799, 801, 800, 810, 790, 800, 812, 788, 800, 400];
  const samples = rr.map((v, i) => ({ t: i * 800, rr_ms: [v] }));
  const r = rrSummary(samples);
  assert.equal(r.rr_count, 20); // 2500 out of range, 400 = >20% jump
  assert.equal(r.rejected, 2);
  assert.ok(r.rmssd_ms > 10 && r.rmssd_ms < 40, `rmssd ${r.rmssd_ms}`);
  assert.ok(r.sdnn_ms > 5 && r.sdnn_ms < 20, `sdnn ${r.sdnn_ms}`);
  assert.equal(r.pnn50_pct, 11.1); // +60 and -60 among 18 valid diffs (chain resets after each artifact)
  assert.equal(rrSummary(samples.slice(0, 5)), null);
});

test('Workout log: header, instruction, human summary and fenced JSON', () => {
  const { session, notes, samples } = fakeWorkout();
  const log = buildWorkoutLog(session, notes, samples, SETTINGS, { revision: 1, now: session.endedAt + 5000 });
  const lines = log.text.split('\n');
  assert.equal(lines[0], LOG_HEADER);
  assert.equal(lines[1], `log_id: ${session.id} · revision: 1`);
  assert.match(log.text, /save this workout to your workspace training log/);
  assert.match(log.text, /fitness\/workouts\.md/);
  assert.match(log.text, /2–3 sentence takeaway/);
  for (const want of ['- When: ', '- Duration: 10:00 active (paused 1:00)', '- Heart rate: avg ', '- Time in zones: Z1 Warm-up', '- Calories: ~', '- Laps/sets (2)', '- Signal gaps: 1', '- RR/HRV', 'Bench press 4×8 @155 lb', 'effort 7/10', 'sleep ~6 h', 'flags: Shoulder tightness', '- Notes (raw): "Upper body day.']) {
    assert.ok(log.text.includes(want), `missing ${want}`);
  }
  assert.ok(log.text.trimEnd().endsWith('```'));
  const data = parseWorkoutLog(log.text);
  assert.equal(data.format, 'pulse-workout-log');
  assert.equal(data.version, 1);
  assert.equal(data.log_id, session.id);
  assert.match(data.session.started_at, /^2026-10-0\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.equal(data.session.duration_s, 600);
  assert.equal(data.session.paused_s, 60);
  assert.equal(data.session.avg_hr, session.summary.avg);
  assert.equal(data.session.calories_kcal, session.summary.calories);
  assert.equal(data.session.laps.length, 2);
  assert.deepEqual(data.session.gaps, [{ start_s: 100, end_s: 112 }]);
  assert.equal(data.zones.zones.length, 5);
  assert.deepEqual(data.zones.zones.map((z) => [z.min_bpm, z.max_bpm]), [[null, 113], [114, 132], [133, 151], [152, 170], [171, null]]);
  assert.equal(data.zones.total_s, session.summary.zones.reduce((a, b) => a + b, 0));
  assert.equal(data.notes.fields.effort, 7);
  assert.equal(data.notes.fields.sleep_hours, 6);
  assert.deepEqual(data.notes.fields.flags, ['Shoulder tightness']);
  assert.ok(data.notes.labels.includes('Bench press 4×8 @155 lb'));
  assert.equal(data.hr_trace.interval_s, 5);
  assert.deepEqual(data.hr_trace.columns, ['t_s', 'hr']);
  assert.equal(data.hr_trace.points.length, 118); // 120 buckets minus the 2 fully inside the gap (100-109)
  assert.deepEqual(data.hr_trace.points[0], [0, 122]);
  assert.ok(data.hrv && data.hrv.rmssd_ms > 0);
  assert.ok(!/"rr_ms"/.test(log.text), 'raw RR must not be sent');
  assert.ok(log.summary.startsWith(LOG_HEADER) && !log.summary.includes('```'));
  assert.ok(Buffer.byteLength(log.text) < 20 * 1024 * 1024);
});

test('Workout log: no notes, no RR, no calories -> fields null and summary says so', () => {
  const { session, samples } = fakeWorkout({ seconds: 60, rr: false });
  session.summary = { ...session.summary, calories: null };
  const log = buildWorkoutLog(session, null, samples, SETTINGS);
  const data = parseWorkoutLog(log.text);
  assert.equal(data.notes, null);
  assert.equal(data.hrv, null);
  assert.equal(data.session.calories_kcal, null);
  assert.match(log.text, /- Notes: none/);
  assert.ok(!log.text.includes('- Calories'));
});

// ---------------------------------------------------------------- coach sync (retry/status)
function memDb(seed = {}) {
  const stores = new Map();
  const st = (n) => { if (!stores.has(n)) stores.set(n, new Map()); return stores.get(n); };
  const keyOf = (n, v) => (n === 'coachlog' ? v.sessionId : n === 'notes' ? v.sessionId : n === 'chats' ? v.key : v.id);
  for (const [n, vals] of Object.entries(seed)) for (const v of vals) st(n).set(keyOf(n, v), structuredClone(v));
  return {
    async get(n, k) { const v = st(n).get(k); return v ? structuredClone(v) : undefined; },
    async put(n, v) { st(n).set(keyOf(n, v), structuredClone(v)); },
    async del(n, k) { st(n).delete(k); },
    async getAll(n) { return [...st(n).values()].map((v) => structuredClone(v)); },
    async getSamples(id) { return structuredClone(seed.samples?.filter((x) => x.sessionId === id) || []); },
  };
}

test('Coach sync: failure -> failed, retry -> sent with reply + chat; dedupe and no resend', async () => {
  const { session, notes, samples } = fakeWorkout({ seconds: 120 });
  session.id = 's1';
  const db = memDb({ sessions: [session], notes: [{ ...notes, sessionId: 's1' }], samples });
  let fail = true;
  const sent = [];
  const settings = { ...COACH, ...SETTINGS, coachSessionKey: 'agent:main:tg:1' };
  const cs = createCoachSync({
    db, getSettings: () => settings, isConfigured: () => true, buildLog: buildWorkoutLog,
    send: async (s, text) => { sent.push(text); if (fail) throw new Error('Could not reach the coach'); return 'Good aerobic base today.'; },
  });
  const events = [];
  cs.onChange((id, rec) => events.push(rec.status));
  await cs.queue('s1');
  assert.equal((await cs.status('s1')).status, 'pending');
  const r1 = await cs.sendNow('s1');
  assert.equal(r1.status, 'failed');
  assert.equal(r1.attempts, 1);
  assert.match(r1.error, /Could not reach/);
  assert.deepEqual(events, ['pending', 'sending', 'failed']);
  assert.equal((await db.get('chats', 'session:s1')), undefined);

  fail = false;
  assert.equal(await cs.retryAll(), 1);
  const r2 = await cs.status('s1');
  assert.equal(r2.status, 'sent');
  assert.equal(r2.attempts, 2);
  assert.equal(r2.reply, 'Good aerobic base today.');
  assert.ok(sent[1].startsWith(LOG_HEADER));
  const chat = await db.get('chats', 'session:s1');
  assert.deepEqual(chat.messages.map((m) => [m.role, m.kind]), [['user', 'workout-log'], ['assistant', 'workout-log-reply']]);
  assert.ok(!chat.messages[0].content.includes('```json'), 'chat bubble holds the human summary only');

  // queue() after success is a no-op, retryAll() skips sent records
  assert.equal((await cs.queue('s1')).status, 'sent');
  assert.equal(await cs.retryAll(), 0);
  assert.equal(sent.length, 2);

  // concurrent sends share one request; manual resend bumps revision
  const [a, b] = await Promise.all([cs.sendNow('s1'), cs.sendNow('s1')]);
  assert.equal(a, b);
  assert.equal(sent.length, 3);
  assert.match(sent[2], /revision: 2/);
});

test('Coach sync: offline or unconfigured keeps it pending; interrupted "sending" is retried', async () => {
  const { session, samples } = fakeWorkout({ seconds: 30 });
  session.id = 's2';
  const db = memDb({ sessions: [session], samples: samples.map((x) => ({ ...x, sessionId: 's2' })), coachlog: [{ sessionId: 's2', status: 'sending', attempts: 1, sentCount: 0 }] });
  let online = false;
  let calls = 0;
  const cs = createCoachSync({
    db, getSettings: () => ({ ...COACH, ...SETTINGS }), isConfigured: () => true, buildLog: buildWorkoutLog,
    online: () => online, send: async () => { calls++; return 'ok'; },
  });
  assert.equal(await cs.retryAll(), 0);
  assert.equal((await cs.sendNow('s2')).status, 'pending');
  assert.equal(calls, 0);
  online = true;
  assert.equal(await cs.retryAll(), 1);
  assert.equal((await cs.status('s2')).status, 'sent');
});

test('Coach sync: a deleted session is not sent', async () => {
  const db = memDb({ coachlog: [{ sessionId: 'gone', status: 'failed', attempts: 3 }] });
  let calls = 0;
  const cs = createCoachSync({ db, getSettings: () => COACH, isConfigured: () => true, buildLog: buildWorkoutLog, send: async () => { calls++; return ''; } });
  await cs.retryAll();
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------- coach-proxy.mjs
async function withProxy(env, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"ok"}}]}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proxyPath = fileURLToPath(new URL('../tools/coach-proxy.mjs', import.meta.url));
  const child = spawn(process.execPath, [proxyPath], {
    env: { ...process.env, PULSE_ORIGIN: 'https://me.github.io', GATEWAY_URL: `http://127.0.0.1:${upstream.address().port}`, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { if (String(d).includes('Pulse coach proxy')) resolve(); });
      child.on('exit', (code) => reject(new Error(`proxy exited ${code}`)));
    });
    return await fn(`http://127.0.0.1:${port}`, seen);
  } finally { child.kill(); upstream.close(); upstream.closeAllConnections?.(); }
}

test('Proxy: preflight allows x-openclaw-session-key; header forwarded; env default only when absent', async () => {
  await withProxy({ OPENCLAW_SESSION_KEY: 'agent:main:telegram:dm:7' }, async (base, seen) => {
    const pre = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS', headers: { Origin: 'https://me.github.io', 'Access-Control-Request-Headers': 'authorization,x-openclaw-session-key' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /x-openclaw-session-key/i);
    const post = (headers) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Origin: 'https://me.github.io', Authorization: 'Bearer t', 'Content-Type': 'application/json', ...headers }, body: '{}' });
    await post({ 'x-openclaw-session-key': 'agent:main:from-browser' });
    await post({});
    await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer t' } });
    assert.equal(seen[0].headers['x-openclaw-session-key'], 'agent:main:from-browser');
    assert.equal(seen[0].headers.authorization, 'Bearer t');
    assert.equal(seen[1].headers['x-openclaw-session-key'], 'agent:main:telegram:dm:7');
    assert.equal(seen[2].headers['x-openclaw-session-key'], undefined);
  });
  await withProxy({ OPENCLAW_SESSION_KEY: '' }, async (base, seen) => {
    await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{}' });
    assert.equal(seen[0].headers['x-openclaw-session-key'], undefined);
  });
});

test('Proxy: refuses to start with a reserved OPENCLAW_SESSION_KEY', async () => {
  await assert.rejects(() => withProxy({ OPENCLAW_SESSION_KEY: 'cron:nightly' }, async () => {}), /proxy exited 1/);
});
