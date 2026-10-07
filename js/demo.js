// Demo history generator so the dashboard can be explored without real workouts.
import * as db from './db.js';
import { uuid } from './recorder.js';
import { summarizeSamples } from './stats.js';
import { parseNotes } from './notes-parser.js';

const NOTE_TEMPLATES = {
  Strength: [
    (r) => `Upper body day. Bench ${r.sets} sets of ${r.reps} at ${r.bench}, felt strong. Pull-ups 3 by ${r.reps + 2}. ${r.flag ? 'Shoulders tight on the last set. ' : ''}Effort ${r.effort} out of 10, slept about ${r.sleep} hours.`,
    (r) => `Leg day. Squats ${r.sets} sets of 5 at ${r.squat}. Romanian deadlifts 3 by 10 at 135. ${r.flag ? 'Left knee a bit sore. ' : ''}Effort ${r.effort} out of 10. Slept ${r.sleep} hours.`,
  ],
  Run: [(r) => `Easy run on the treadmill, ${r.km}k. Effort ${r.effort} out of 10. Slept ${r.sleep} hours.`],
  Cycling: [(r) => `Bike trainer intervals, legs felt ${r.flag ? 'tired' : 'fresh'}. Effort ${r.effort} out of 10, slept ${r.sleep} hours.`],
  HIIT: [(r) => `HIIT circuit, burpees and kettlebell swings 5 rounds. Effort ${r.effort} out of 10. Slept about ${r.sleep} hours.`],
  Yoga: [(r) => `Yoga flow and mobility. ${r.flag ? 'Hips tight. ' : ''}Effort ${r.effort} out of 10. Slept ${r.sleep} hours.`],
};

const PROFILE = {
  Strength: { base: 112, work: 38, dur: [40, 55] },
  Run: { base: 135, work: 18, dur: [28, 45] },
  Cycling: { base: 128, work: 30, dur: [35, 60] },
  HIIT: { base: 130, work: 40, dur: [20, 30] },
  Yoga: { base: 88, work: 10, dur: [25, 45] },
};

function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export async function generateDemoHistory(settings, weeks = 10) {
  const now = Date.now();
  const types = ['Strength', 'Strength', 'Run', 'Cycling', 'HIIT', 'Yoga', 'Strength'];
  let bench = 135, squat = 185;
  let count = 0;
  for (let d = weeks * 7; d >= 1; d--) {
    if (Math.random() > 0.55) continue;
    const day = new Date(now - d * 86400000);
    day.setHours(18 + Math.floor(rand(0, 2)), Math.floor(rand(0, 59)), 0, 0);
    const type = pick(types);
    const p = PROFILE[type];
    const durS = Math.round(rand(p.dur[0], p.dur[1]) * 60);
    const sleep = Math.round(rand(5, 8.5) * 2) / 2;
    const tired = sleep < 6 ? 7 : 0;
    const id = uuid();
    const startedAt = day.getTime();
    const samples = [];
    const laps = [];
    let hr = 85;
    let lap = 1;
    const lapEvery = type === 'Strength' ? 300 : type === 'HIIT' ? 120 : 600;
    for (let t = 0; t <= durS; t += 2) {
      const ramp = Math.min(1, t / 300);
      const working = (t % 120) < 75;
      const target = p.base * (0.75 + 0.25 * ramp) + tired + (working ? p.work * ramp : 0);
      hr += (target - hr) * 0.08 + rand(-1.5, 1.5);
      if (t > 0 && t % lapEvery === 0) { lap++; laps.push({ n: lap, t: startedAt + t * 1000, elapsed_s: t }); }
      const bpm = Math.round(hr);
      samples.push({ sessionId: id, seq: samples.length, t: startedAt + t * 1000, elapsed_s: t, hr: bpm, rr_ms: [Math.round(60000 / bpm)], lap });
    }
    const session = {
      id, startedAt, endedAt: startedAt + durS * 1000, status: 'complete', type, source: 'demo',
      device: { name: 'Demo strap', id: 'demo' }, laps, pauses: [], gaps: [], durationS: durS,
      summary: summarizeSamples(samples, settings, []), lastSampleAt: startedAt + durS * 1000,
      updatedAt: Date.now(), syncedAt: null, schema: 1, demo: true,
    };
    if (type === 'Strength') { bench += Math.random() > 0.6 ? 5 : 0; squat += Math.random() > 0.6 ? 10 : 0; }
    const r = {
      sets: pick([3, 4, 5]), reps: pick([5, 6, 8, 10]), bench, squat, km: pick([3, 5, 6, 8]),
      effort: Math.max(3, Math.min(10, Math.round((session.summary.avg - 80) / 9))), sleep, flag: Math.random() > 0.7,
    };
    const text = pick(NOTE_TEMPLATES[type])(r);
    await db.put('sessions', session);
    await db.putMany('samples', samples);
    await db.put('notes', { sessionId: id, text, parsed: parseNotes(text, { unit: 'lb', type }), updatedAt: Date.now() });
    count++;
  }
  return count;
}

export async function removeDemoHistory() {
  const all = await db.getAll('sessions');
  let n = 0;
  for (const s of all) if (s.demo) { await db.deleteSessionLocal(s.id); n++; }
  return n;
}
