// Fuel: meal logging pipeline (local-first) and the numbers on the Fuel tab.
//
// Logging never waits on the network: logMeal() writes the meal (thumbnail + note) to
// IndexedDB and, if there is a photo, the downscaled photo to `mealphotos`. Estimation runs
// afterwards (process()) and is retried when back online:
//   queued -> estimating -> (needs_answers: up to 3 tap questions) -> done
// The full photo is deleted once the estimate is done (only the thumbnail stays).
// Then the meal goes to the coach's FOOD channel as PULSE MEAL LOG v1 (food route) and is
// pushed to Supabase by sync.js. Weigh-ins follow the same path on the weighins route.
// Demo entries are never sent automatically and never synced.
//
// Dependencies are injected so this runs in Node tests with an in-memory db.

import {
  buildIdentifyQuestions, buildDetailQuestions, decideRequest, gate, applyPicks, candidateKeys, resolveEstimate, needsCoach,
  DEFAULT_THRESHOLD, DEFAULT_MAX_ASK, DEFAULT_MODEL,
} from './fuel-questions.js';
import { FOOD_BY_KEY, MAIN_MEALS, guessMeal, mealNutrition, foodsInText } from './fuel-nutrition.js';
import { buildMealLog, buildWeighInLog, coachItemsMessage, parseCoachItems, parseTargets, isDemoEntry } from './fuel-log.js';

const pad = (n) => String(n).padStart(2, '0');
export const localDate = (ms = Date.now()) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const localTime = (ms = Date.now()) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const addDays = (date, n) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + n); return localDate(d.getTime()); };
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * @param {object} deps
 * @param {{get, put, del, getAll}} deps.db
 * @param {(request) => Promise<{answers}>} deps.decide          Decisions API (server endpoint or mock); null = off
 * @param {(settings, message) => Promise<string>} deps.askCoach  one message (text + photo) into the food channel
 * @param {(settings, text) => Promise<string>} deps.sendLog      PULSE MEAL LOG v1 into the food channel
 * @param {() => object} deps.getSettings
 * @param {(settings, route) => object|null} deps.routeSettings   settings for the food/weighins channel (null = none)
 * @param {(settings) => boolean} deps.coachReady                  gateway configured?
 */
export function createFuel({
  db, decide, askCoach, sendLog, getSettings, routeSettings, coachReady = () => true,
  online = () => true, now = () => Date.now(), onChange = () => {}, onTargets = () => {},
}) {
  const running = new Map();
  const listeners = new Set();
  const emit = (kind, rec) => { listeners.forEach((fn) => { try { fn(kind, rec); } catch (e) { console.warn(e); } }); onChange(kind, rec); };
  const save = async (store, rec) => { await db.put(store, rec); emit(store, rec); return rec; };

  // ------------------------------------------------------------ create
  async function logMeal({ photo = null, thumb = null, note = '', meal = null, at = now(), demo = false } = {}) {
    const t = now();
    const rec = {
      log_id: uuid(), revision: 1, date: localDate(at), time: localTime(at), meal: meal || guessMeal(new Date(at)),
      notes_raw: String(note || '').trim() || null, status: 'logged', thumb, hasPhoto: !!photo, demo: !!demo, source: demo ? 'demo' : 'pulse',
      createdAt: t, updatedAt: t,
      estimate: { state: photo || String(note || '').trim() ? 'queued' : 'none', attempts: 0 },
      coach: { status: 'pending' },
    };
    if (photo) await db.put('mealphotos', { log_id: rec.log_id, photo });
    return save('meals', rec);
  }

  async function skipMeal({ meal, date = localDate(now()), demo = false }) {
    const t = now();
    const existing = (await db.getAll('meals')).find((m) => m.date === date && m.meal === meal && m.status === 'skipped' && !m.deleted);
    if (existing) return existing;
    return save('meals', {
      log_id: uuid(), revision: 1, date, time: localTime(t), meal, notes_raw: null, status: 'skipped', thumb: null, hasPhoto: false,
      demo: !!demo, source: demo ? 'demo' : 'pulse', createdAt: t, updatedAt: t, estimate: { state: 'none' }, coach: { status: 'pending' },
    });
  }

  /** Copy a previous meal or a favourite (no estimation needed). */
  async function repeatMeal({ from, meal = null, label = 'repeat', demo = false }) {
    const t = now();
    const src = typeof from === 'string' ? await db.get('meals', from) : from;
    if (!src) return null;
    const e = src.estimate || {};
    return save('meals', {
      log_id: uuid(), revision: 1, date: localDate(t), time: localTime(t), meal: meal || guessMeal(new Date(t)),
      notes_raw: `${label === 'favorite' ? 'Favourite' : 'Same as'} ${src.name || `${src.date} ${src.meal}`}`, status: 'logged', thumb: src.thumb || null, hasPhoto: false,
      demo: !!demo, source: demo ? 'demo' : 'pulse', createdAt: t, updatedAt: t,
      estimate: (() => {
        const items = (e.items || src.items || []).map(({ key, name, portion, custom }) => ({ key, name, portion, ...(custom ? { custom } : {}), source: label, confidence: 1 }));
        const mods = { fat: e.fat || 'a_little', eaten: e.eaten || 'all' };
        return { ...mealNutrition(items, mods), ...mods, state: 'done', estimate_source: label, confidence: 1, ask: [], decided: null, model: null };
      })(),
      coach: { status: 'pending' },
    });
  }

  async function logWeighIn({ lbs, note = '', at = now(), demo = false }) {
    const v = Math.round(Number(lbs) * 10) / 10;
    if (!(v >= 50 && v <= 700)) throw new Error('Enter a weight between 50 and 700 lb');
    const t = now();
    return save('weighins', {
      log_id: uuid(), revision: 1, date: localDate(at), time: localTime(at), lbs: v, note: String(note || '').trim() || null,
      demo: !!demo, source: demo ? 'demo' : 'pulse', createdAt: t, updatedAt: t, coach: { status: 'pending' },
    });
  }

  // ------------------------------------------------------------ estimate
  function settingsOf() {
    const s = getSettings();
    return { s, threshold: Number(s.decideThreshold) || DEFAULT_THRESHOLD, maxAsk: Number.isFinite(+s.decideMaxAsk) ? +s.decideMaxAsk : DEFAULT_MAX_ASK, model: s.decideModel || DEFAULT_MODEL };
  }

  /** Run (or continue) estimation for one meal. Concurrent calls share one run. Never rejects. */
  function process(logId) {
    if (running.has(logId)) return running.get(logId);
    const p = (async () => {
      let meal = await db.get('meals', logId);
      if (!meal || meal.status !== 'logged' || meal.deleted) return meal;
      const st = meal.estimate?.state;
      if (!['queued', 'estimating', 'failed'].includes(st)) return meal;
      if (!online()) return save('meals', { ...meal, estimate: { ...meal.estimate, state: 'queued' } });
      const { s, threshold, maxAsk, model } = settingsOf();
      meal = await save('meals', { ...meal, estimate: { ...meal.estimate, state: 'estimating', attempts: (meal.estimate.attempts || 0) + 1, error: null } });
      const photo = (await db.get('mealphotos', logId))?.photo || null;
      const favorites = s.fuelFavorites || [];
      try {
        const decider = typeof decide === 'function' && s.decideMode !== 'off' ? decide : null;
        if (!decider) {
          // no decision layer: the coach estimates everything (needs a food channel)
          return finalize(logId, {}, { model: null, threshold });
        }
        const base = { model, meal: meal.meal, time: meal.time, note: meal.notes_raw, photo, favorites };
        const q1 = buildIdentifyQuestions({ favorites });
        const r1 = await decider(decideRequest(base, q1));
        const favPick = r1.answers?.favorite?.choice;
        const favConf = Number(r1.answers?.favorite?.confidence) || 0;
        const favMatched = favPick && favPick !== 'none' && favConf >= threshold;
        const known = favMatched ? [] : foodsInText(meal.notes_raw);
        const keys = favMatched ? [] : [...new Set([...known, ...candidateKeys(r1.answers)])];
        const cooked = keys.filter((k) => FOOD_BY_KEY[k]?.cooked).length;
        const q2 = buildDetailQuestions(keys, { askFat: favMatched || cooked > 0, askPortions: !favMatched });
        const r2 = await decider(decideRequest(base, q2));
        const questions = { ...q1, ...q2 };
        const answers = { ...(r1.answers || {}), ...(r2.answers || {}) };
        const kcalGuess = keys.reduce((a, k) => a + (FOOD_BY_KEY[k]?.kcal || 0), 0);
        // presence of foods that were never candidates is settled ("no") without asking
        const g = gate(questions, answers, { threshold, maxAsk, known, ctx: { cookedCount: cooked, kcal: kcalGuess } });
        const fresh = await db.get('meals', logId);
        if (!fresh) return null;
        const estimate = { ...fresh.estimate, model: r1.model || model, threshold, decided: g.accepted, ask: g.ask, mock: !!r1.mock, usage: [r1.usage, r2.usage].filter(Boolean) };
        if (g.ask.length) return save('meals', { ...fresh, estimate: { ...estimate, state: 'needs_answers' } });
        await save('meals', { ...fresh, estimate });
        return finalize(logId, g.accepted, { model: estimate.model, threshold });
      } catch (e) {
        const fresh = await db.get('meals', logId);
        if (!fresh) return null;
        const error = String(e?.message || e).slice(0, 300);
        // Endpoint not set up (401/403/404/503) or failing repeatedly: don't hold the meal hostage;
        // let the food coach estimate from the photo (or log it without numbers).
        if ([401, 403, 404, 503].includes(e?.status) || (fresh.estimate.attempts || 0) >= 3) {
          await save('meals', { ...fresh, estimate: { ...fresh.estimate, error } });
          return finalize(logId, {}, { model: null, threshold });
        }
        return save('meals', { ...fresh, estimate: { ...fresh.estimate, state: 'failed', error } });
      }
    })().catch((e) => { console.warn('fuel estimate failed', e); return null; }).finally(() => running.delete(logId));
    running.set(logId, p);
    return p;
  }

  /** The user tapped answers for the pending questions: {name: value}. */
  async function answer(logId, picks) {
    const meal = await db.get('meals', logId);
    if (!meal || meal.estimate?.state !== 'needs_answers') return meal;
    const decided = applyPicks(meal.estimate.decided || {}, meal.estimate.ask, picks);
    await save('meals', { ...meal, estimate: { ...meal.estimate, decided, ask: [], answered: picks } });
    return finalize(logId, decided, { model: meal.estimate.model, threshold: meal.estimate.threshold });
  }

  async function finalize(logId, decided, { model, threshold }) {
    let meal = await db.get('meals', logId);
    if (!meal) return null;
    const { s } = settingsOf();
    const photo = (await db.get('mealphotos', logId))?.photo || null;
    let coachItems = [];
    let coachNote = null;
    if (needsCoach(decided)) {
      const fs = routeSettings(s, 'food');
      if (fs && coachReady(fs) && online() && askCoach) {
        try {
          const known = Object.entries(decided).filter(([n, d]) => n.startsWith('has_') && d.value === true).map(([n]) => FOOD_BY_KEY[n.slice(4)]?.name);
          const reply = await askCoach(fs, coachItemsMessage({ meal: meal.meal, note: meal.notes_raw, photo, known }));
          coachItems = parseCoachItems(reply);
          if (!coachItems.length) coachNote = 'Coach found nothing else';
        } catch (e) { coachNote = `Coach could not name the other items: ${String(e?.message || e).slice(0, 160)}`; }
      } else coachNote = 'Some items need the coach (set the Food channel key in Settings)';
    }
    const r = resolveEstimate(decided, { favorites: s.fuelFavorites || [], coachItems });
    meal = (await db.get('meals', logId)) || meal;
    const partial = needsCoach(decided) && !coachItems.length && !r.items.length;
    const estimate = {
      ...meal.estimate, ...r, decided, model, threshold, ask: [], state: 'done',
      estimate_source: partial ? 'none' : r.estimate_source, finishedAt: now(),
      coachNote: coachNote || (meal.estimate?.error ? `Estimate service: ${meal.estimate.error}` : null),
    };
    await db.del('mealphotos', logId); // only the thumbnail stays on the device
    meal = await save('meals', { ...meal, estimate, updatedAt: now(), revision: (meal.revision || 1) + (meal.estimate?.state === 'done' ? 1 : 0) });
    return meal;
  }

  /** Edit an item's portion / remove it after the fact (bumps revision, re-sends). */
  async function editItems(logId, items, mods = {}) {
    const meal = await db.get('meals', logId);
    if (!meal) return null;
    const fat = mods.fat || meal.estimate?.fat || 'a_little';
    const eaten = mods.eaten || meal.estimate?.eaten || 'all';
    const r = mealNutrition(items, { fat, eaten });
    const estimate = { ...meal.estimate, ...r, fat, eaten, state: 'done', estimate_source: 'user-edit', confidence: 1 };
    return save('meals', { ...meal, estimate, revision: (meal.revision || 1) + 1, updatedAt: now(), coach: { ...(meal.coach || {}), status: 'pending' } });
  }

  async function deleteMeal(logId) {
    const meal = await db.get('meals', logId);
    if (!meal) return;
    await db.del('mealphotos', logId);
    await save('meals', { ...meal, deleted: true, updatedAt: now() });
  }

  // ------------------------------------------------------------ coach delivery (food channel)
  const STORE_OF = { meal: 'meals', weigh_in: 'weighins' };

  /** Send one meal / weigh-in log. Never rejects. Demo: only with manual=true. */
  async function sendToCoach(kind, logId, { manual = false } = {}) {
    const store = STORE_OF[kind];
    const rec = await db.get(store, logId);
    if (!rec || rec.deleted) return rec;
    if (isDemoEntry(rec) && !manual) return rec;
    if (kind === 'meal' && rec.status === 'logged' && rec.estimate?.state !== 'done' && rec.estimate?.state !== 'none') return rec; // wait for the estimate
    const s = getSettings();
    const rs = routeSettings(s, kind === 'meal' ? 'food' : 'weighins');
    if (!rs || !coachReady(rs)) return save(store, { ...rec, coach: { ...(rec.coach || {}), status: 'no-channel' } });
    if (!online()) return save(store, { ...rec, coach: { ...(rec.coach || {}), status: 'pending' } });
    await save(store, { ...rec, coach: { ...(rec.coach || {}), status: 'sending', attempts: (rec.coach?.attempts || 0) + 1 } });
    try {
      const log = kind === 'meal' ? buildMealLog(rec, { now: now() }) : buildWeighInLog(rec, { now: now() });
      const reply = await sendLog(rs, log.text);
      const fresh = await db.get(store, logId);
      const t = parseTargets(reply);
      if (t) onTargets(t);
      return save(store, { ...fresh, coach: { status: 'sent', sentAt: now(), sentRevision: rec.revision, reply: reply || '', error: null, attempts: fresh.coach?.attempts } });
    } catch (e) {
      const fresh = await db.get(store, logId);
      return save(store, { ...fresh, coach: { ...(fresh.coach || {}), status: 'failed', error: String(e?.message || e).slice(0, 300) } });
    }
  }

  /** Retry everything waiting: queued estimates, then unsent logs. Returns counts. */
  async function retryAll() {
    if (!online()) return { estimated: 0, sent: 0 };
    let estimated = 0; let sent = 0;
    const meals = (await db.getAll('meals')).filter((m) => !m.deleted).sort((a, b) => a.createdAt - b.createdAt);
    for (const m of meals) {
      if (m.status === 'logged' && ['queued', 'estimating', 'failed'].includes(m.estimate?.state) && !running.has(m.log_id)) {
        const r = await process(m.log_id);
        if (r?.estimate?.state === 'done' || r?.estimate?.state === 'needs_answers') estimated++;
      }
    }
    for (const m of await db.getAll('meals')) {
      if (m.deleted || isDemoEntry(m)) continue;
      if (['pending', 'failed', 'sending', 'no-channel'].includes(m.coach?.status) && (m.estimate?.state === 'done' || m.status === 'skipped')) {
        if ((await sendToCoach('meal', m.log_id))?.coach?.status === 'sent') sent++;
      }
    }
    for (const w of await db.getAll('weighins')) {
      if (w.deleted || isDemoEntry(w)) continue;
      if (['pending', 'failed', 'sending', 'no-channel'].includes(w.coach?.status)) {
        if ((await sendToCoach('weigh_in', w.log_id))?.coach?.status === 'sent') sent++;
      }
    }
    return { estimated, sent };
  }

  return {
    logMeal, skipMeal, repeatMeal, logWeighIn, process, answer, editItems, deleteMeal, sendToCoach, retryAll,
    isRunning: (id) => running.has(id),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// ---------------------------------------------------------------- numbers for the Fuel tab
export function dayTotals(meals, date) {
  const day = meals.filter((m) => m.date === date && !m.deleted);
  const done = day.filter((m) => m.status === 'logged' && m.estimate?.state === 'done');
  const sum = (k) => done.reduce((a, m) => a + (m.estimate[k] || 0), 0);
  return {
    kcal: Math.round(sum('kcal')), protein_g: Math.round(sum('protein_g')), carbs_g: Math.round(sum('carbs_g')), fat_g: Math.round(sum('fat_g')),
    logged: day.filter((m) => m.status === 'logged').length, skipped: day.filter((m) => m.status === 'skipped').length,
    pending: day.filter((m) => m.status === 'logged' && m.estimate?.state !== 'done' && m.estimate?.state !== 'none').length,
    mains: MAIN_MEALS.filter((k) => day.some((m) => m.meal === k)),
  };
}

/** A day counts when breakfast, lunch and dinner are each logged or explicitly skipped. */
export function dayComplete(meals, date) {
  return MAIN_MEALS.every((k) => meals.some((m) => !m.deleted && m.date === date && m.meal === k));
}

/** Consecutive complete days ending today (or yesterday, if today isn't complete yet). */
export function streak(meals, today) {
  let d = dayComplete(meals, today) ? today : addDays(today, -1);
  let n = 0;
  while (dayComplete(meals, d) && n < 3650) { n++; d = addDays(d, -1); }
  return n;
}

/** Complete days in the 7 days ending today. */
export function weeklyAdherence(meals, today) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, -6 + i));
  const complete = days.filter((d) => dayComplete(meals, d));
  return { days, complete: complete.length, pct: Math.round((complete.length / 7) * 100), flags: days.map((d) => dayComplete(meals, d)) };
}

/** Last 7 days of weigh-ins (latest per day), with change vs the first point. */
export function weightTrend(weighins, today) {
  const from = addDays(today, -6);
  const byDay = new Map();
  for (const w of weighins.filter((x) => !x.deleted && x.date >= from && x.date <= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) byDay.set(w.date, w);
  const points = [...byDay.values()].map((w) => ({ date: w.date, lbs: w.lbs }));
  const latest = points.at(-1)?.lbs ?? null;
  const change = points.length > 1 ? Math.round((points.at(-1).lbs - points[0].lbs) * 10) / 10 : null;
  const avg = points.length ? Math.round((points.reduce((a, p) => a + p.lbs, 0) / points.length) * 10) / 10 : null;
  return { points, latest, change, avg };
}

/** "Same as yesterday's breakfast" + recent distinct meals for repeat chips. */
export function repeatCandidates(meals, today, meal) {
  const done = meals.filter((m) => !m.deleted && m.status === 'logged' && m.estimate?.state === 'done' && m.estimate.items?.length)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const out = [];
  const y = done.find((m) => m.date === addDays(today, -1) && m.meal === meal);
  if (y) out.push({ log_id: y.log_id, label: `Same as yesterday’s ${meal}` });
  const seen = new Set(out.map((o) => o.log_id));
  for (const m of done) {
    if (out.length >= 3) break;
    const sig = m.estimate.items.map((i) => `${i.key || i.name}:${i.portion}`).join('|');
    if (seen.has(m.log_id) || out.some((o) => o.sig === sig)) continue;
    seen.add(m.log_id);
    out.push({ log_id: m.log_id, sig, label: `Repeat: ${m.estimate.items.slice(0, 2).map((i) => i.name.split(' (')[0]).join(' + ')}` });
  }
  return out;
}

/** Favourite (stored in settings) from a finished meal. */
export function favoriteFromMeal(meal, name) {
  return {
    id: `f${Date.now().toString(36)}`,
    name: String(name || meal.estimate.items.map((i) => i.name.split(' (')[0]).join(' + ')).slice(0, 60),
    meal: meal.meal,
    items: meal.estimate.items.map(({ key, name: n, portion, custom }) => ({ key, name: n, portion, ...(custom ? { custom } : {}) })),
    kcal: meal.estimate.kcal, protein_g: meal.estimate.protein_g,
  };
}
