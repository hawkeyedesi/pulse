// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRateMeasurement, encodeHeartRateMeasurement, parseBatteryLevel } from '../js/hr-parse.js';
import { parseNotes, wordsToNumbers } from '../js/notes-parser.js';
import { zoneFor, zoneBpmBounds, StatsAccumulator, kcalPerMinute, buildTrends, summarizeSamples } from '../js/stats.js';
import {
  readSse, buildMessages, sendChat, sendToSession, coachHeaders, sessionKeyIssue, autoSendEnabled, SESSION_KEY_HEADER,
} from '../js/coach.js';
import {
  downsampleHr, rrSummary, buildWorkoutLog, parseWorkoutLog, LOG_HEADER, guessKind, isDemoSession, supabaseWorkoutRow, KINDS,
} from '../js/workout-log.js';
import { needsPush, sessionFromRow } from '../js/sync.js';
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
  assert.match(log.text, /map this into health\.sqlite3 per its existing write rules/);
  assert.match(log.text, /upsert days for 2026-10-07 first, then upsert workouts by log_id/);
  assert.match(log.text, /full JSON below in polar_json/);
  assert.match(log.text, /do not insert demo/);
  assert.match(log.text, /workout-log\.md updated as you already do/);
  assert.match(log.text, /2–3 sentence takeaway/);
  assert.ok(!/fitness\/workouts/.test(log.text), 'old fitness/ file instruction is gone');
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

const COACH_FIELDS = ['log_id', 'revision', 'date', 'kind', 'status', 'source', 'started_at', 'ended_at', 'duration_s',
  'avg_hr', 'max_hr', 'min_hr', 'calories_kcal', 'zones', 'hrv', 'hr_trace', 'notes_raw', 'summary'];

test('Workout log: top-level fields mirror the coach workouts row; no invented number', () => {
  const { session, notes, samples } = fakeWorkout();
  const data = parseWorkoutLog(buildWorkoutLog(session, notes, samples, SETTINGS, { revision: 3 }).text);
  for (const k of COACH_FIELDS) assert.ok(k in data, `missing top-level ${k}`);
  assert.ok(!('number' in data), 'session number is left for the coach');
  assert.equal(data.revision, 3);
  assert.equal(data.date, '2026-10-07');
  assert.equal(data.date, data.started_at.slice(0, 10));
  assert.equal(data.status, 'done');
  assert.equal(data.source, 'pulse');
  assert.equal(data.kind, 'other'); // upper-body notes that don't say A or B
  assert.equal(data.duration_s, 600);
  assert.equal(data.avg_hr, session.summary.avg);
  assert.equal(data.max_hr, session.summary.max);
  assert.equal(data.min_hr, session.summary.min);
  assert.equal(data.calories_kcal, session.summary.calories);
  assert.equal(data.notes_raw, notes.text);
  assert.equal(data.zones.zones.length, 5);
  assert.ok(data.hrv.rmssd_ms > 0);
  assert.equal(data.hr_trace.interval_s, 5);
  assert.ok(!data.summary.includes('\n') && data.summary.length < 300);
  assert.match(data.summary, /^Other \(Strength\) · 10:00 · avg \d+\/max \d+ bpm · ~\d+ kcal · Bench press 4×8 @155 lb · effort 7\/10 · flags: Shoulder tightness$/);
  assert.equal(data.session.source, 'ble'); // coach bridge checks session.source for demo
  // explicit kind wins over the guess
  const d2 = parseWorkoutLog(buildWorkoutLog({ ...session, kind: 'upper-b' }, notes, samples, SETTINGS).text);
  assert.equal(d2.kind, 'upper-b');
  assert.match(d2.summary, /^Upper B/);
});

test('Workout log: demo strap -> source demo and a do-not-insert instruction', () => {
  const { session, notes, samples } = fakeWorkout({ seconds: 60 });
  for (const demo of [{ ...session, source: 'demo' }, { ...session, demo: true }]) {
    assert.equal(isDemoSession(demo), true);
    const log = buildWorkoutLog(demo, notes, samples, SETTINGS);
    const data = parseWorkoutLog(log.text);
    assert.equal(data.source, 'demo');
    assert.match(log.text, /DEMO \/ CONNECTION TEST/);
    assert.match(log.text, /Do NOT insert it into health\.sqlite3/);
    assert.ok(!/map this into health\.sqlite3/.test(log.text));
    assert.match(data.summary, /DEMO \/ CONNECTION TEST$/);
  }
  assert.equal(isDemoSession(session), false);
});

test('Kind guess from dictated notes', () => {
  const cases = [
    ['Upper body day. Bench 4 sets of 8 at 155. Pull-ups 3 by 10.', 'other'],
    ['Upper A today. Bench and rows.', 'upper-a'],
    ['upper b, overhead press and pull-ups', 'upper-b'],
    ['Workout B: rows and curls', 'upper-b'],
    ['Day A. Bench press 5x5', 'upper-a'],
    ['A good session, felt strong', 'other'],
    ['Leg day. Squats 5 sets of 5 at 225. Romanian deadlifts 3 by 10.', 'lower'],
    ['Walking lunges and leg press', 'lower'],
    ['Easy zone 2 run, 5k on the treadmill', 'cardio'],
    ['Row erg 20 minutes steady', 'cardio'],
    ['Bike trainer intervals, legs felt tired', 'cardio'],
    ['Bench then squats, full body', 'other'],
    ['', 'other'],
  ];
  for (const [text, want] of cases) assert.equal(guessKind(text), want, text);
  assert.equal(guessKind('', 'Run'), 'cardio');
  assert.equal(guessKind('', 'Strength'), 'other');
  assert.deepEqual(KINDS, ['upper-a', 'upper-b', 'lower', 'cardio', 'other']);
});

test('Supabase workouts row: coach columns + extras, upsert key log_id, no number, no raw RR', () => {
  const { session, notes, samples } = fakeWorkout();
  const data = parseWorkoutLog(buildWorkoutLog({ ...session, kind: 'upper-a' }, notes, samples, SETTINGS, { revision: 2 }).text);
  const row = supabaseWorkoutRow(data, 'user-1');
  assert.deepEqual(Object.keys(row).sort(), ['avg_hr', 'calories_kcal', 'date', 'deleted_at', 'duration_s', 'ended_at', 'hr_trace_json', 'hrv_json',
    'kind', 'log_id', 'max_hr', 'min_hr', 'notes_raw', 'polar_json', 'revision', 'source', 'started_at', 'status', 'summary', 'user_id', 'zones_json'].sort());
  assert.equal(row.log_id, session.id);
  assert.equal(row.revision, 2);
  assert.equal(row.kind, 'upper-a');
  assert.equal(row.source, 'pulse');
  assert.equal(row.polar_json, data);
  assert.ok(!/"rr_ms"/.test(JSON.stringify(row)), 'raw RR never stored');
  assert.ok(!('user_id' in supabaseWorkoutRow(data)));
});

test('Sync: demo never pushed; v2 bookkeeping; rows rebuild a local session', () => {
  const base = { id: 'x', status: 'complete', updatedAt: 10 };
  assert.equal(needsPush(base), true);
  assert.equal(needsPush({ ...base, syncedAt: 10 }), true, 'v1 syncedAt does not count: re-push into workouts');
  assert.equal(needsPush({ ...base, cloudSyncedAt: 10 }), false);
  assert.equal(needsPush({ ...base, cloudSyncedAt: 5 }), true);
  assert.equal(needsPush({ ...base, source: 'demo' }), false);
  assert.equal(needsPush({ ...base, demo: true }), false);
  assert.equal(needsPush({ ...base, status: 'active' }), false);
  const { session, notes, samples } = fakeWorkout();
  const data = parseWorkoutLog(buildWorkoutLog({ ...session, kind: 'lower' }, notes, samples, SETTINGS).text);
  const row = { ...supabaseWorkoutRow(data), updated_at: '2026-10-07T19:00:00Z', number: 12 };
  const r = sessionFromRow(row, SETTINGS);
  assert.equal(r.session.id, session.id);
  assert.equal(r.session.kind, 'lower');
  assert.equal(r.session.startedAt, session.startedAt);
  assert.equal(r.session.durationS, 600);
  assert.equal(r.session.summary.avg, session.summary.avg);
  assert.equal(r.session.cloudSyncedAt, r.session.updatedAt);
  assert.equal(needsPush(r.session), false);
  assert.equal(r.samples.length, data.hr_trace.points.length);
  assert.ok(r.samples.every((x) => x.rr_ms.length === 0));
  assert.equal(r.notes.text, notes.text);
  assert.equal(r.session.laps.length, 1);
  assert.deepEqual(r.session.gaps.map((g) => [g.startElapsed, g.endElapsed]), [[100, 112]]);
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

test('Coach sync: demo sessions are never auto-sent or retried; manual send allowed and marked demo', async () => {
  const { session, notes, samples } = fakeWorkout({ seconds: 60 });
  session.id = 'd1'; session.source = 'demo';
  const db = memDb({ sessions: [session], notes: [{ ...notes, sessionId: 'd1' }], samples: samples.map((x) => ({ ...x, sessionId: 'd1' })) });
  const sent = [];
  let fail = false;
  const cs = createCoachSync({ db, getSettings: () => ({ ...COACH, ...SETTINGS }), isConfigured: () => true, buildLog: buildWorkoutLog,
    send: async (s, text) => { sent.push(text); if (fail) throw new Error('down'); return 'Got the connection test.'; } });
  assert.equal(await cs.queue('d1'), null, 'demo is never queued');
  assert.equal(await cs.sendNow('d1'), null, 'automatic send is a no-op for demo');
  assert.equal(sent.length, 0);
  fail = true;
  assert.equal((await cs.sendNow('d1', { manual: true })).status, 'failed');
  assert.equal(await cs.retryAll(), 0, 'failed demo send is not retried automatically');
  assert.equal(sent.length, 1);
  fail = false;
  assert.equal((await cs.sendNow('d1', { manual: true })).status, 'sent');
  const data = parseWorkoutLog(sent[1]);
  assert.equal(data.source, 'demo');
  assert.match(sent[1], /Do NOT insert/);
});

test('Coach sync: kind edit bumps revision and force re-queues a sent log', async () => {
  const { session, samples } = fakeWorkout({ seconds: 60 });
  session.id = 'k1';
  const db = memDb({ sessions: [session], samples: samples.map((x) => ({ ...x, sessionId: 'k1' })) });
  const sent = [];
  const cs = createCoachSync({ db, getSettings: () => ({ ...COACH, ...SETTINGS }), isConfigured: () => true, buildLog: buildWorkoutLog,
    send: async (s, text) => { sent.push(parseWorkoutLog(text)); return 'ok'; } });
  await cs.queue('k1');
  assert.equal((await cs.sendNow('k1')).status, 'sent');
  assert.deepEqual([sent[0].revision, sent[0].kind], [1, 'other']);
  // what the session page does on a kind change
  await db.put('sessions', { ...(await db.get('sessions', 'k1')), kind: 'upper-b', revision: 2 });
  assert.equal((await cs.queue('k1')).status, 'sent', 'plain queue is still a no-op after success');
  assert.equal((await cs.queue('k1', { force: true })).status, 'pending');
  assert.equal(await cs.retryAll(), 1);
  assert.deepEqual([sent[1].revision, sent[1].kind, sent[1].log_id], [2, 'upper-b', 'k1']);
  // revision never goes backwards: later manual resend -> 3
  await cs.sendNow('k1', { manual: true });
  assert.equal(sent[2].revision, 3);
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

// ================================================================ Fuel (food logging)
import {
  FOODS, FOOD_BY_KEY, itemNutrition, mealNutrition, guessMeal, foodsInText, portionLabel,
} from '../js/fuel-nutrition.js';
import {
  buildIdentifyQuestions, buildDetailQuestions, decideRequest, gate, applyPicks, readAnswer, resolveEstimate,
  needsCoach, mockDecide, expectedPortion, candidateKeys, DEFAULT_MODEL,
} from '../js/fuel-questions.js';
import { migrateChannels, settingsForRoute, channelFor, normalizeChannels, syncLegacyKey } from '../js/channels.js';
import {
  buildMealLog, buildWeighInLog, parseMealLog, mealLogData, supabaseMealRow, supabaseWeighInRow, parseCoachItems,
  coachItemsMessage, parseTargets, MEAL_LOG_HEADER,
} from '../js/fuel-log.js';
import { createFuel, dayTotals, streak, weeklyAdherence, weightTrend, addDays, repeatCandidates } from '../js/fuel.js';
import { handleDecide, validateDecide } from '../_worker.js';
import { mealNeedsPush, weighInNeedsPush } from '../js/sync.js';

function fuelDb() {
  const stores = new Map();
  const st = (n) => { if (!stores.has(n)) stores.set(n, new Map()); return stores.get(n); };
  return {
    async get(n, k) { const v = st(n).get(k); return v ? structuredClone(v) : undefined; },
    async put(n, v) { st(n).set(v.log_id, structuredClone(v)); },
    async del(n, k) { st(n).delete(k); },
    async getAll(n) { return [...st(n).values()].map((v) => structuredClone(v)); },
  };
}
const LEGACY = 'agent:main:telegram:group:-1003761327335:topic:2609';
const FOOD = 'agent:main:telegram:group:-100777:topic:42';

test('Fuel table: every food has unique key, macros and >=2 portion options with unique keys', () => {
  assert.equal(new Set(FOODS.map((f) => f.key)).size, FOODS.length);
  for (const f of FOODS) {
    assert.ok(f.kcal > 0 && f.protein_g >= 0 && f.carbs_g >= 0 && f.fat_g >= 0, f.key);
    assert.ok(f.portions.length >= 2, f.key);
    assert.equal(new Set(f.portions.map((p) => p.key)).size, f.portions.length, f.key);
    // energy roughly consistent with macros (4/4/9), within 30 %
    const est = f.protein_g * 4 + f.carbs_g * 4 + f.fat_g * 9;
    assert.ok(Math.abs(est - f.kcal) / f.kcal < 0.3, `${f.key}: ${est} vs ${f.kcal}`);
  }
  for (const k of ['rice', 'roti', 'dal', 'paneer_curry', 'idli', 'dosa', 'eggs', 'oatmeal', 'chicken_breast', 'pizza', 'burger']) assert.ok(FOOD_BY_KEY[k], k);
});

test('Fuel math: portions, cooking fat and amount eaten', () => {
  assert.deepEqual(itemNutrition({ key: 'rice', portion: 'one_cup' }), { kcal: 205, protein_g: 4.3, carbs_g: 45, fat_g: 0.4 });
  assert.equal(itemNutrition({ key: 'roti', portion: 'two' }).kcal, 220);
  // cooked dish: "a lot" of fat adds a tablespoon (120 kcal, 13.5 g fat); "none" removes the base oil
  assert.equal(itemNutrition({ key: 'dal', portion: 'one_cup' }, { fat: 'a_lot' }).kcal, 320);
  assert.equal(itemNutrition({ key: 'dal', portion: 'one_cup' }, { fat: 'none' }).kcal, 180);
  assert.equal(itemNutrition({ key: 'rice', portion: 'one_cup' }, { fat: 'a_lot' }).kcal, 205); // plain rice: not a cooked dish
  assert.equal(itemNutrition({ key: 'dal', portion: 'one_cup' }, { eaten: 'half' }).kcal, 100);
  const m = mealNutrition([{ key: 'rice', portion: 'one_cup' }, { key: 'roti', portion: 'two' }, { key: 'dal', portion: 'one_cup' }]);
  assert.equal(m.kcal, 625);
  assert.equal(m.protein_g, 23.3);
  // coach-provided values for an unknown item
  assert.equal(itemNutrition({ key: null, custom: { kcal: 410, protein_g: 22 } }, { eaten: 'half' }).kcal, 205);
  assert.equal(portionLabel('roti', 'two'), '2 pieces');
  assert.equal(portionLabel('rice', 'one_half_cup'), '1½ cups');
});

test('Fuel: meal type from the clock and foods named in a note', () => {
  const at = (h, m = 0) => new Date(2026, 10, 1, h, m);
  assert.equal(guessMeal(at(8)), 'breakfast');
  assert.equal(guessMeal(at(12, 30)), 'lunch');
  assert.equal(guessMeal(at(19)), 'dinner');
  assert.equal(guessMeal(at(16)), 'snack');
  assert.equal(guessMeal(at(23)), 'snack');
  assert.deepEqual(foodsInText('Dal, rice and 2 rotis cooked in ghee').sort(), ['dal', 'rice']);
  assert.deepEqual(foodsInText('butter chicken with naan'), ['naan', 'chicken_curry']);
});

test('Question bank: fixed answers only, valid for the Decisions API, <=128 per call', () => {
  const favs = [{ id: 'a1', name: 'Usual breakfast', items: [{ key: 'oatmeal', portion: 'one_cup' }] }];
  const q1 = buildIdentifyQuestions({ favorites: favs });
  assert.ok(Object.keys(q1).length <= 128);
  assert.equal(q1.has_rice.type, 'noul');
  assert.equal(q1.other_food.type, 'noul');
  assert.deepEqual(Object.keys(q1.favorite.criteria), ['none', 'fav_a1']);
  const q2 = buildDetailQuestions(['rice', 'roti', 'nope'], { askFat: true });
  assert.deepEqual(Object.keys(q2), ['portion_rice', 'portion_roti', 'fat', 'eaten']);
  assert.deepEqual(Object.keys(q2.portion_rice.criteria), ['half_cup', 'one_cup', 'one_half_cup', 'two_plus']);
  assert.deepEqual(Object.keys(q2.fat.criteria), ['none', 'a_little', 'a_lot']);
  assert.deepEqual(Object.keys(q2.eaten.criteria), ['all', 'most', 'half', 'little']);
  const req = decideRequest({ meal: 'lunch', time: '12:30', note: 'x'.repeat(2000), photo: 'data:image/jpeg;base64,AAAA', favorites: favs }, q1);
  assert.equal(req.model, DEFAULT_MODEL);
  assert.equal(req.state.note.length, 1000);
  assert.deepEqual(req.state.photo, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
  assert.deepEqual(req.state.saved_meals, ['Usual breakfast']);
  assert.equal(decideRequest({ model: 'gpt-4' }, q2).model, DEFAULT_MODEL);
  // what the server accepts
  assert.ok(validateDecide(req).body);
  assert.ok(validateDecide(decideRequest({}, { ...q1, ...q2 })).body);
});

test('Confidence gating: noul |2p-1|, choice confidence; silent vs asked; max 3; impact order', () => {
  assert.equal(readAnswer({ type: 'noul' }, { type: 'noul', noul: 0.9 }).confidence.toFixed(2), '0.80');
  const q = { ...buildIdentifyQuestions(), ...buildDetailQuestions(['rice', 'roti', 'dal', 'eggs'], { askFat: true }) };
  const ch = (choice, confidence) => ({ type: 'choice', choice, confidence, probabilities: {} });
  const answers = {};
  for (const f of FOODS) answers[`has_${f.key}`] = { type: 'noul', noul: ['rice', 'roti', 'dal'].includes(f.key) ? 0.97 : 0.02 };
  answers.has_eggs = { type: 'noul', noul: 0.95 };
  answers.other_food = { type: 'noul', noul: 0.05 };
  Object.assign(answers, { portion_rice: ch('one_cup', 0.3), portion_roti: ch('two', 0.4), portion_dal: ch('one_cup', 0.9), portion_eggs: ch('two', 0.2), fat: ch('a_little', 0.1), eaten: ch('all', 0.95) });
  const g = gate(q, answers, { threshold: 0.6, maxAsk: 3, ctx: { cookedCount: 2 } });
  assert.equal(g.ask.length, 3);
  assert.deepEqual(g.ask.map((x) => x.name), ['fat', 'portion_rice', 'portion_roti']); // biggest kcal swing first
  assert.equal(g.accepted.portion_dal.source, 'model');
  assert.equal(g.accepted.portion_eggs.source, 'model-low'); // over budget: model's answer, flagged low
  assert.equal(g.accepted.has_rice.value, true);
  assert.equal(g.accepted.has_pizza.value, false);
  assert.deepEqual(g.ask[1].options.map((o) => o.label), ['½ cup', '1 cup', '1½ cups', '2+ cups']);
  // a higher threshold asks more, maxAsk 0 asks nothing
  assert.equal(gate(q, answers, { threshold: 0.99, maxAsk: 0 }).ask.length, 0);
});

test('Gating: uncertain foods become ONE multi-select (likely pre-selected); note foods count; portions only for known foods', () => {
  const q = { ...buildIdentifyQuestions(), ...buildDetailQuestions(['rice', 'dal', 'dosa', 'sabzi'], { askFat: false }) };
  const r = mockDecide(decideRequest({ note: 'thali with rice and dal' }, q));
  const g = gate(q, r.answers, { threshold: 0.6, maxAsk: 3, known: ['rice', 'dal'] });
  const check = g.ask.find((x) => x.name === 'items_check');
  assert.ok(check && check.multi);
  assert.deepEqual(check.options.map((o) => o.value), ['sabzi', 'salad', 'sambar', 'dosa']);
  assert.deepEqual(check.suggested, ['sabzi', 'salad']);
  assert.equal(g.accepted.has_rice.source, 'note');
  assert.ok(!g.ask.some((x) => x.name === 'portion_dosa'), 'no portion question for a food still being checked');
  const decided = applyPicks(g.accepted, g.ask, { items_check: ['sabzi'] });
  assert.equal(decided.has_sabzi.value, true);
  assert.equal(decided.has_salad.value, false);
  assert.equal(decided.has_salad.source, 'user');
  const est = resolveEstimate(decided);
  assert.deepEqual(est.items.map((i) => i.key).sort(), ['dal', 'rice', 'sabzi']);
  // ignoring the check uses the suggestions
  const est2 = resolveEstimate(applyPicks(g.accepted, g.ask, {}));
  assert.deepEqual(est2.items.map((i) => i.key).sort(), ['dal', 'rice', 'sabzi', 'salad']);
});

test('expectedPortion: probability-weighted, not argmax', () => {
  assert.equal(expectedPortion('rice', { half_cup: 0.05, one_cup: 0.4, one_half_cup: 0.2, two_plus: 0.35 }), 'one_half_cup');
  assert.equal(expectedPortion('rice', { one_cup: 1 }), 'one_cup');
  assert.equal(expectedPortion('nope', { one_cup: 1 }), null);
});

test('Estimate: user answers win, confidence + estimate_source, favourites and coach items', () => {
  const decided = {
    has_rice: { value: true, confidence: 0.94, source: 'model' }, portion_rice: { value: 'one_half_cup', confidence: 1, source: 'user' },
    has_dal: { value: true, confidence: 0.9, source: 'model' }, portion_dal: { value: 'one_cup', confidence: 0.8, source: 'model' },
    fat: { value: 'a_lot', confidence: 1, source: 'user' }, eaten: { value: 'all', confidence: 0.9, source: 'model' },
    other_food: { value: false, confidence: 0.9, source: 'model' },
  };
  const e = resolveEstimate(decided);
  assert.equal(e.kcal, Math.round(205 * 1.5 + 320));
  assert.equal(e.estimate_source, 'decider');
  assert.ok(e.confidence > 0.8 && e.confidence <= 1);
  assert.equal(needsCoach(decided), false);
  assert.equal(needsCoach({ ...decided, other_food: { value: true, confidence: 0.9 } }), true);
  assert.equal(needsCoach({ has_rice: { value: false, confidence: 0.9 } }), true); // nothing recognised
  const withCoach = resolveEstimate(decided, { coachItems: [{ name: 'Gulab jamun', portion: '2', kcal: 300, protein_g: 4, carbs_g: 45, fat_g: 12, confidence: 0.6 }] });
  assert.equal(withCoach.estimate_source, 'decider+coach');
  assert.equal(withCoach.kcal, e.kcal + 300);
  const favs = [{ id: 'x', name: 'Usual', items: [{ key: 'oatmeal', name: 'Oatmeal', portion: 'one_cup' }] }];
  const f = resolveEstimate({ favorite: { value: 'fav_x', confidence: 0.9, source: 'model' }, eaten: { value: 'all', confidence: 0.9 } }, { favorites: favs });
  assert.equal(f.estimate_source, 'favorite');
  assert.equal(f.kcal, 160);
});

test('Coach channels: legacy key migrates to Workouts; food/weigh-ins never fall back to the workout thread', () => {
  const legacy = { coachSessionKey: LEGACY, gatewayUrl: 'g', gatewayToken: 't' };
  const mig = migrateChannels(legacy);
  assert.deepEqual(mig.coachChannels, [
    { id: 'workouts', name: 'Workouts', sessionKey: LEGACY, routes: ['workouts'] },
    { id: 'food', name: 'Food', sessionKey: '', routes: ['food', 'weighins'] },
  ]);
  assert.equal(migrateChannels({ ...legacy, ...mig }), null); // idempotent
  const s = { ...legacy, ...mig };
  assert.equal(settingsForRoute(s, 'workouts').coachSessionKey, LEGACY);
  assert.equal(settingsForRoute(s, 'food'), null); // food key not set yet
  assert.equal(settingsForRoute(s, 'weighins'), null);
  s.coachChannels[1].sessionKey = FOOD;
  assert.equal(settingsForRoute(s, 'food').coachSessionKey, FOOD);
  assert.equal(settingsForRoute(s, 'weighins').coachSessionKey, FOOD);
  assert.equal(settingsForRoute(s, 'food').gatewayToken, 't');
  // pre-channel settings object (never migrated): workouts keep the legacy key
  assert.equal(settingsForRoute(legacy, 'workouts').coachSessionKey, LEGACY);
  assert.equal(channelFor(legacy, 'food'), null);
  // normalisation + legacy mirror
  const n = normalizeChannels([{ name: 'A b!', sessionKey: ' k ', routes: ['food', 'bogus'] }, { name: 'A b!', routes: ['workouts'] }]);
  assert.deepEqual(n.map((c) => c.id), ['a-b', 'a-b-2']);
  assert.deepEqual(n[0].routes, ['food']);
  assert.equal(n[0].sessionKey, 'k');
  assert.equal(syncLegacyKey([{ sessionKey: 'w', routes: ['workouts'] }]), 'w');
});

const MEAL = {
  log_id: 'm-1', revision: 2, date: '2026-11-01', time: '12:41', meal: 'lunch', notes_raw: 'cooked in ghee', status: 'logged', hasPhoto: true, source: 'pulse',
  thumb: 'data:image/jpeg;base64,THUMB',
  estimate: { state: 'done', items: [{ key: 'rice', name: 'Rice (cooked)', portion: 'one_cup', kcal: 205, protein_g: 4.3 }, { key: null, name: 'Mystery stew', portion: '1 bowl', kcal: 410 }],
    kcal: 615, protein_g: 26.3, carbs_g: 75, fat_g: 20.4, estimate_source: 'decider+coach', confidence: 0.82, fat: 'a_lot', eaten: 'all', decided: { has_rice: { value: true } }, model: 'pplx-decider-flash-v1.2', threshold: 0.6 },
};

test('PULSE MEAL LOG v1: header, coach meals-row fields, instruction, round trip, no photos', () => {
  const log = buildMealLog(MEAL, { now: Date.parse('2026-11-01T20:45:00Z') });
  assert.ok(log.text.startsWith(`${MEAL_LOG_HEADER}\nlog_id: m-1 · revision: 2 · record: meal`));
  const d = parseMealLog(log.text);
  for (const k of ['log_id', 'revision', 'date', 'time', 'items', 'source', 'meal', 'status', 'notes_raw', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'estimate_source', 'confidence', 'answers_json']) assert.ok(k in d, k);
  assert.equal(d.items, 'Rice (cooked) 1 cup, Mystery stew 1 bowl');
  assert.equal(d.kcal, 615);
  assert.equal(d.source, 'pulse');
  assert.match(log.text, /upsert meals by log_id/);
  assert.ok(!log.text.includes('data:image') && !log.text.includes('THUMB'));
  const skipped = mealLogData({ ...MEAL, status: 'skipped', estimate: { state: 'none' } });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.items, 'Skipped');
  assert.equal(skipped.kcal, null);
  const demo = buildMealLog({ ...MEAL, demo: true, source: 'demo' });
  assert.match(demo.text, /Do NOT insert/);
  const w = buildWeighInLog({ log_id: 'w-1', revision: 1, date: '2026-11-01', time: '07:02', lbs: 176.4, note: null });
  const wd = parseMealLog(w.text);
  assert.equal(wd.record, 'weigh_in');
  assert.equal(wd.lbs, 176.4);
  assert.match(w.text, /upsert weigh_ins by log_id/);
});

test('Meal log rows for Supabase + coach item/targets parsing', () => {
  const row = supabaseMealRow(MEAL, 'u1');
  assert.equal(row.user_id, 'u1');
  assert.equal(row.items, 'Rice (cooked) 1 cup, Mystery stew 1 bowl');
  assert.ok(!('thumb' in row) && !JSON.stringify(row).includes('data:image'));
  assert.deepEqual(Object.keys(supabaseWeighInRow({ log_id: 'w', date: '2026-11-01', lbs: 170 })).sort(), ['date', 'deleted_at', 'lbs', 'log_id', 'note', 'revision']);
  assert.deepEqual(parseCoachItems('Sure!\n```json\n{"items":[{"name":"Gulab jamun","portion":"2","kcal":300,"protein_g":4}]}\n```'),
    [{ name: 'Gulab jamun', portion: '2', kcal: 300, protein_g: 4, carbs_g: 0, fat_g: 0, confidence: 0.5 }]);
  assert.deepEqual(parseCoachItems('no json here'), []);
  const msg = coachItemsMessage({ meal: 'dinner', note: 'n', photo: 'data:image/jpeg;base64,AA', known: ['Rice'] });
  assert.equal(msg.content[1].type, 'image_url');
  assert.match(msg.content[0].text, /^PULSE FOOD ID v1/);
  assert.deepEqual(parseTargets('ok\nTARGETS: kcal=2100 protein_g=150'), { kcal: 2100, protein_g: 150 });
  assert.equal(parseTargets('nothing'), null);
  assert.equal(mealNeedsPush({ ...MEAL, updatedAt: 2 }), true);
  assert.equal(mealNeedsPush({ ...MEAL, updatedAt: 2, cloudSyncedAt: 2 }), false);
  assert.equal(mealNeedsPush({ ...MEAL, demo: true, updatedAt: 2 }), false);
  assert.equal(mealNeedsPush({ ...MEAL, estimate: { state: 'needs_answers' }, updatedAt: 2 }), false);
  assert.equal(mealNeedsPush({ ...MEAL, deleted: true, updatedAt: 3 }), false); // never synced: nothing to delete
  assert.equal(weighInNeedsPush({ log_id: 'w', updatedAt: 1 }), true);
});

test('Fuel pipeline: log -> questions -> answers -> food channel; offline queue; demo never auto-sent', async () => {
  const db = fuelDb();
  let online = false;
  const sent = []; const asked = [];
  const settings = { gatewayUrl: 'g', gatewayToken: 't', coachSessionKey: LEGACY, decideMode: 'mock', decideThreshold: 0.6, decideMaxAsk: 3,
    coachChannels: [{ id: 'workouts', name: 'W', sessionKey: LEGACY, routes: ['workouts'] }, { id: 'food', name: 'F', sessionKey: FOOD, routes: ['food', 'weighins'] }] };
  const fuel = createFuel({
    db, decide: async (r) => mockDecide(r), getSettings: () => settings, routeSettings: settingsForRoute, coachReady: () => true, online: () => online,
    askCoach: async (s, m) => { asked.push([s.coachSessionKey, m]); return '```json\n{"items":[{"name":"Mystery stew","kcal":410,"protein_g":22}]}\n```'; },
    sendLog: async (s, text) => { sent.push([s.coachSessionKey, text]); return 'Logged.'; },
  });
  const m = await fuel.logMeal({ photo: 'data:image/jpeg;base64,AAAA', thumb: 't', note: 'dal rice and 2 roti', meal: 'lunch' });
  assert.equal(m.estimate.state, 'queued');
  assert.equal((await db.get('mealphotos', m.log_id)).photo, 'data:image/jpeg;base64,AAAA');
  assert.equal((await fuel.process(m.log_id)).estimate.state, 'queued'); // offline: stays queued
  online = true;
  const p = await fuel.process(m.log_id);
  assert.equal(p.estimate.state, 'needs_answers');
  assert.deepEqual(p.estimate.ask.map((q) => q.name).sort(), ['fat', 'portion_rice']);
  assert.equal((await fuel.sendToCoach('meal', m.log_id)).coach.status, 'pending'); // waits for the estimate
  const done = await fuel.answer(m.log_id, { portion_rice: 'one_cup', fat: 'a_little' });
  assert.equal(done.estimate.state, 'done');
  assert.equal(done.estimate.kcal, 625);
  assert.equal(await db.get('mealphotos', m.log_id), undefined); // full photo gone, thumbnail kept
  assert.equal(done.thumb, 't');
  const s1 = await fuel.sendToCoach('meal', m.log_id);
  assert.equal(s1.coach.status, 'sent');
  assert.equal(sent[0][0], FOOD);
  assert.equal(parseMealLog(sent[0][1]).kcal, 625);
  // unknown item -> the coach names it (photo + note on the food channel)
  const u = await fuel.logMeal({ photo: 'data:image/jpeg;base64,BBBB', note: 'mystery stew', meal: 'dinner' });
  const ud = await fuel.process(u.log_id);
  assert.equal(ud.estimate.estimate_source, 'coach');
  assert.equal(ud.estimate.kcal, 410);
  assert.equal(asked[0][0], FOOD);
  assert.equal(asked[0][1].content[1].image_url.url, 'data:image/jpeg;base64,BBBB');
  // skipped + weigh-in + demo
  const sk = await fuel.skipMeal({ meal: 'breakfast', date: m.date });
  assert.equal((await fuel.skipMeal({ meal: 'breakfast', date: m.date })).log_id, sk.log_id); // idempotent
  const w = await fuel.logWeighIn({ lbs: '176.44' });
  assert.equal(w.lbs, 176.4);
  await assert.rejects(() => fuel.logWeighIn({ lbs: 20 }));
  const demo = await fuel.logMeal({ note: 'banana', demo: true });
  await fuel.process(demo.log_id);
  const before = sent.length;
  const r = await fuel.retryAll();
  assert.ok(r.sent >= 2); // the coach-named dinner, the skip, the weigh-in
  assert.ok(sent.slice(before).every(([k]) => k === FOOD));
  assert.ok(!sent.some(([, t]) => t.includes('"source":"demo"')));
  assert.ok(sent.some(([, t]) => parseMealLog(t).record === 'weigh_in'));
  // no food channel key -> nothing sent, marked no-channel
  settings.coachChannels[1].sessionKey = '';
  const n = await fuel.logMeal({ note: 'oatmeal', meal: 'snack' });
  await fuel.process(n.log_id);
  await fuel.answer(n.log_id, {}); // best guesses
  assert.equal((await fuel.sendToCoach('meal', n.log_id)).coach.status, 'no-channel');
});

test('Fuel repeat / favourite copy items and recompute totals', async () => {
  const db = fuelDb();
  const fuel = createFuel({ db, decide: async (r) => mockDecide(r), getSettings: () => ({ decideMode: 'mock' }), routeSettings: () => null, askCoach: null, sendLog: null });
  await db.put('meals', { ...MEAL, estimate: { ...MEAL.estimate, items: [{ key: 'rice', name: 'Rice (cooked)', portion: 'one_cup' }] }, createdAt: 1 });
  const r = await fuel.repeatMeal({ from: 'm-1', meal: 'dinner' });
  assert.equal(r.estimate.estimate_source, 'repeat');
  assert.equal(r.estimate.kcal, 205); // plain rice: fat modifier doesn't apply
  const f = await fuel.repeatMeal({ from: { name: 'Usual', items: [{ key: 'eggs', name: 'Eggs', portion: 'two' }] }, label: 'favorite' });
  assert.equal(f.estimate.estimate_source, 'favorite');
  assert.equal(f.estimate.kcal, 156);
});

test('Fuel numbers: totals, streak, weekly adherence (main meals logged or skipped), weight trend, repeat chips', () => {
  const today = '2026-11-01';
  const mk = (date, meal, extra = {}) => ({ log_id: `${date}-${meal}`, date, time: '12:00', meal, status: 'logged', createdAt: 1, estimate: { state: 'done', kcal: 500, protein_g: 30, items: [{ key: 'rice', name: 'Rice (cooked)', portion: 'one_cup' }] }, ...extra });
  const meals = [];
  for (const d of [addDays(today, -1), addDays(today, -2), addDays(today, -4)]) for (const k of ['breakfast', 'lunch', 'dinner']) meals.push(mk(d, k));
  meals.push(mk(today, 'breakfast'), mk(today, 'lunch', { status: 'skipped', estimate: { state: 'none' } }), mk(today, 'snack', { estimate: { state: 'estimating' } }));
  const t = dayTotals(meals, today);
  assert.equal(t.kcal, 500);
  assert.equal(t.pending, 1);
  assert.deepEqual(t.mains, ['breakfast', 'lunch']);
  assert.equal(streak(meals, today), 2); // today incomplete -> counts back from yesterday; gap on day -3
  meals.push(mk(today, 'dinner'));
  assert.equal(streak(meals, today), 3);
  const wk = weeklyAdherence(meals, today);
  assert.equal(wk.complete, 4);
  assert.equal(wk.flags.length, 7);
  const wt = weightTrend([{ log_id: 'a', date: addDays(today, -6), time: '07:00', lbs: 178 }, { log_id: 'b', date: today, time: '07:00', lbs: 176.5 }, { log_id: 'c', date: today, time: '06:00', lbs: 177 }, { log_id: 'd', date: addDays(today, -9), time: '07:00', lbs: 180 }], today);
  assert.deepEqual(wt.points.map((p) => p.lbs), [178, 176.5]);
  assert.equal(wt.change, -1.5);
  const rc = repeatCandidates(meals, today, 'lunch');
  assert.equal(rc[0].label, 'Same as yesterday’s lunch');
});

test('Server /api/decide: key stays server-side, token required, validation, upstream errors mapped', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    if (body.state.note === 'rate') return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '2' } });
    return new Response(JSON.stringify({ model: body.model, answers: { has_rice: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 478, output_tokens: 1 } }), { status: 200, headers: { 'x-request-id': 'rid-1' } });
  };
  const env = { PERPLEXITY_API_KEY: 'pplx-secret', PULSE_API_TOKEN: 'tok' };
  const body = decideRequest({ note: 'rice', photo: 'data:image/jpeg;base64,AAAA' }, { has_rice: buildIdentifyQuestions().has_rice });
  const post = (b, auth = 'Bearer tok', e = env) => handleDecide(new Request('https://pulse-hr.pages.dev/api/decide', { method: 'POST', headers: { authorization: auth }, body: JSON.stringify(b) }), e, { fetchImpl });
  let r = await post(body);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { model: DEFAULT_MODEL, answers: { has_rice: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 478, output_tokens: 1 }, request_id: 'rid-1' });
  assert.equal(calls[0].url, 'https://api.perplexity.ai/v1/decisions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer pplx-secret');
  assert.ok(!JSON.stringify(j).includes('pplx-secret'));
  assert.equal((await post(body, 'Bearer nope')).status, 401);
  assert.equal((await post(body, 'Bearer tok', { PERPLEXITY_API_KEY: 'k' })).status, 401); // no token configured: closed
  assert.equal((await post(body, 'Bearer tok', { PULSE_API_TOKEN: 'tok' })).status, 503);
  assert.equal((await post({ ...body, model: 'gpt-4o' })).status, 400);
  assert.equal((await post({ ...body, state: { ...body.state, photo: { type: 'image_url', image_url: { url: 'https://evil/x.jpg' } } } })).status, 400);
  assert.equal((await post({ ...body, state: { ...body.state, extra: 1 } })).status, 400);
  assert.equal((await post({ ...body, questions: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }])) })).status, 400);
  assert.equal((await post({ ...body, questions: { BAD: { type: 'noul', instructions: 'x' } } })).status, 400);
  const rl = await post({ ...body, state: { ...body.state, note: 'rate' } });
  assert.equal(rl.status, 429);
  assert.equal(rl.headers.get('retry-after'), '2');
  assert.match((await rl.json()).error.message, /429: slow down/);
  assert.equal(calls.length, 2); // rejected requests never reached Perplexity
  const h = await handleDecide(new Request('https://x/api/decide/health', { headers: { authorization: 'Bearer tok' } }), env, { fetchImpl });
  assert.equal(h.status, 200);
  assert.equal((await handleDecide(new Request('https://x/api/decide', { method: 'GET', headers: { authorization: 'Bearer tok' } }), env)).status, 405);
});

test('Proxy /api/decide: needs a bearer the gateway accepts; 503 without PERPLEXITY_API_KEY', async () => {
  await withProxy({ PERPLEXITY_API_KEY: '' }, async (base, seen) => {
    const ok = await fetch(`${base}/api/decide/health`, { headers: { Authorization: 'Bearer t', Origin: 'https://me.github.io' } });
    assert.equal(ok.status, 503); // gateway accepted the bearer (upstream answers 200), but no key configured
    assert.equal(seen[0].url, '/v1/models');
    assert.equal((await fetch(`${base}/api/decide/health`, { headers: { Origin: 'https://me.github.io' } })).status, 401);
    const pre = await fetch(`${base}/api/decide`, { method: 'OPTIONS', headers: { Origin: 'https://me.github.io', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
  });
});

test('Fuel: estimate endpoint not set up (401) -> coach estimates instead of blocking the meal', async () => {
  const db = fuelDb();
  const sent = [];
  const settings = { gatewayUrl: 'g', gatewayToken: 't', decideMode: 'pages', coachChannels: [{ id: 'food', name: 'F', sessionKey: FOOD, routes: ['food'] }] };
  const fuel = createFuel({
    db, getSettings: () => settings, routeSettings: settingsForRoute, coachReady: () => true,
    decide: async () => { const e = new Error('Invalid Pulse endpoint token'); e.status = 401; throw e; },
    askCoach: async () => '```json\n{"items":[{"name":"Dal rice","kcal":520,"protein_g":18}]}\n```',
    sendLog: async (s, text) => { sent.push(text); return 'ok'; },
  });
  const m = await fuel.logMeal({ photo: 'data:image/jpeg;base64,AAAA', note: 'lunch' });
  const r = await fuel.process(m.log_id);
  assert.equal(r.estimate.state, 'done');
  assert.equal(r.estimate.estimate_source, 'coach');
  assert.equal(r.estimate.kcal, 520);
  assert.match(r.estimate.coachNote || '', /Estimate service: Invalid Pulse endpoint token/);
  // no coach either -> logged without numbers (kcal null in the log), not stuck
  settings.coachChannels[0].sessionKey = '';
  const n = await fuel.logMeal({ note: 'snack' });
  const rn = await fuel.process(n.log_id);
  assert.equal(rn.estimate.estimate_source, 'none');
  assert.equal(mealLogData(rn).kcal, null);
});
