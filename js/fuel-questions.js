// Fuel: fixed question bank for the Perplexity Decisions API, confidence gating, and the
// mapping from answers to an estimate. Pure functions (Node-testable); no network here.
//
// Decision models only choose among predefined answers, so every question is built from the
// nutrition table (fuel-nutrition.js): presence of each known food (noul), something-else
// present (noul), favourite match (choice), then portion per present food (choice over that
// food's portion options), cooking fat (choice) and amount eaten (choice).
//
// Two calls per meal:  identify (presence + other + favourite)  ->  detail (portions + fat + eaten)
// Answers with confidence >= threshold are accepted silently. The rest are ranked by how much
// they move the calorie total and at most `maxAsk` (default 3) are shown to the user as tap
// buttons with the same options; the remainder fall back to the model's top answer.
// Presence is special (live tests showed the models over-detect on busy plates, e.g. a thali
// scored dosa 0.79 / fruit 0.77): a food counts silently only at p >= (1 + threshold) / 2;
// every uncertain food goes into ONE multi-select question ("Which of these are on your
// plate?", likely ones pre-selected) that costs one of the maxAsk slots. Foods the note names
// ("dal, rice, 2 roti") count as present without asking.
//
// Confidence: choice -> the API's `confidence` ((p_top - 1/n) / (1 - 1/n)); noul -> |2p - 1|
// (same scale: 0 at 50/50, 1 when certain).

import {
  FOODS, FOOD_BY_KEY, FAT_LEVELS, FAT_LABELS, EATEN, EATEN_LABELS, portionImpact, mealNutrition, foodsInText,
} from './fuel-nutrition.js';

export const DEFAULT_MODEL = 'pplx-decider-v1.2';
export const MODELS = ['pplx-decider-v1.2', 'pplx-decider-flash-v1.2'];
export const DEFAULT_THRESHOLD = 0.6;
export const DEFAULT_MAX_ASK = 3;
export const PRESENT_CUTOFF = 0.5;   // p(yes) at/above which a noul reads as "yes"
export const CANDIDATE_CUTOFF = 0.3; // p(yes) at/above which a food gets a portion question
export const SUGGEST_P = 0.65;       // uncertain foods at/above this are pre-selected / used as fallback
export const MAX_CHECK_OPTIONS = 8;  // foods offered in the multi-select check

const FAT_IMPACT = 140;   // kcal swing between "none" and "a lot" per cooked dish (approx.)

/** Stage 1: what is on the plate? */
export function buildIdentifyQuestions({ favorites = [] } = {}) {
  const q = {};
  for (const f of FOODS) {
    q[`has_${f.key}`] = {
      type: 'noul',
      instructions: `Is ${f.name.toLowerCase()} part of this meal (visible in the photo or named in the note)?`,
    };
  }
  q.other_food = {
    type: 'noul',
    instructions: `Is there any food or drink in this meal that is NOT one of these: ${FOODS.map((f) => f.name).join('; ')}?`,
  };
  const favs = favorites.filter((f) => f && f.id && f.name).slice(0, 40);
  if (favs.length) {
    const criteria = { none: 'None of these saved meals' };
    for (const f of favs) criteria[`fav_${f.id}`] = `${f.name}${f.items?.length ? ` (${f.items.map((i) => i.name || FOOD_BY_KEY[i.key]?.name || i.key).join(', ')})` : ''}`;
    q.favorite = { type: 'choice', instructions: 'Is this meal one of the user\'s saved favourite meals?', criteria };
  }
  return q;
}

/** Stage 2: how much of each food, how much fat, how much was eaten. */
export function buildDetailQuestions(keys, { askFat = true, askPortions = true } = {}) {
  const q = {};
  if (askPortions) {
    for (const key of keys) {
      const f = FOOD_BY_KEY[key];
      if (!f) continue;
      const criteria = {};
      for (const p of f.portions) criteria[p.key] = `${p.label}${/^[\d½+]+$/.test(p.label) ? ` ${f.unit}(s)` : ''}`;
      q[`portion_${key}`] = { type: 'choice', instructions: `How much ${f.name.toLowerCase()} is in this meal?`, criteria };
    }
  }
  if (askFat) {
    q.fat = {
      type: 'choice',
      instructions: 'How much cooking fat (oil, ghee, butter) went into this meal? Use the note if it says (e.g. "cooked in ghee", "no oil").',
      criteria: { none: 'No added fat (steamed, boiled, dry)', a_little: 'A little (normal home cooking)', a_lot: 'A lot (fried, rich, oily, lots of ghee or butter)' },
    };
  }
  q.eaten = {
    type: 'choice',
    instructions: 'How much of the food shown did the person eat? Use the note if it says (e.g. "ate half"). Assume all of it unless the note says otherwise.',
    criteria: { all: 'All of it', most: 'Most of it', half: 'About half', little: 'Only a little' },
  };
  return q;
}

/** Request body sent to the server endpoint (which adds the API key and forwards it). */
export function decideRequest({ model = DEFAULT_MODEL, meal, time, note, photo, favorites = [] }, questions) {
  const state = { meal: meal || null, time: time || null, note: String(note || '').slice(0, 1000) };
  if (favorites.length) state.saved_meals = favorites.slice(0, 40).map((f) => f.name);
  if (photo) state.photo = { type: 'image_url', image_url: { url: photo } };
  return { model: MODELS.includes(model) ? model : DEFAULT_MODEL, state, questions };
}

/** {value, confidence, options?} from one API answer. */
export function readAnswer(q, a) {
  if (!a) return { value: null, confidence: 0 };
  if (q.type === 'noul' || a.type === 'noul') {
    const p = Number(a.noul);
    return { value: p >= PRESENT_CUTOFF, p, confidence: Math.abs(2 * p - 1) };
  }
  if (a.type === 'score') {
    const probs = a.probabilities || {};
    const top = Object.entries(probs).sort((x, y) => y[1] - x[1])[0];
    const legend = a.legend || {};
    return { value: top ? (legend[top[0]] ?? top[0]) : null, confidence: Number(a.confidence) || 0, probabilities: probs };
  }
  return { value: a.choice ?? null, confidence: Number(a.confidence) || 0, probabilities: a.probabilities || {} };
}

/** Options shown to the user for a question (same answers the model had). */
export function questionOptions(name, q) {
  if (q.type === 'noul') return [{ value: true, label: 'Yes' }, { value: false, label: 'No' }];
  if (name === 'fat') return FAT_LEVELS.map((v) => ({ value: v, label: FAT_LABELS[v] }));
  if (name === 'eaten') return Object.keys(EATEN).map((v) => ({ value: v, label: EATEN_LABELS[v] }));
  if (name.startsWith('portion_')) {
    const f = FOOD_BY_KEY[name.slice(8)];
    return (f?.portions || []).map((p) => ({ value: p.key, label: /^[\d½+]+$/.test(p.label) ? `${p.label} ${f.unit}${p.mult === 1 ? '' : 's'}` : p.label }));
  }
  return Object.entries(q.criteria || {}).map(([value, label]) => ({ value, label: label || value }));
}

export function questionPrompt(name, q) {
  if (name === 'items_check') return 'Which of these are on your plate?';
  if (name.startsWith('has_')) return `Is there ${FOOD_BY_KEY[name.slice(4)]?.name.toLowerCase() || name.slice(4)}?`;
  if (name.startsWith('portion_')) return `How much ${FOOD_BY_KEY[name.slice(8)]?.name.toLowerCase() || name.slice(8)}?`;
  if (name === 'fat') return 'How much oil / ghee / butter?';
  if (name === 'eaten') return 'How much did you eat?';
  if (name === 'favorite') return 'Is this one of your saved meals?';
  if (name === 'other_food') return 'Is there something else on the plate?';
  return q.instructions;
}

/** kcal a question can move (for ranking which ones to ask). */
export function questionImpact(name, ctx = {}) {
  if (name.startsWith('portion_')) return portionImpact(name.slice(8));
  if (name.startsWith('has_')) return FOOD_BY_KEY[name.slice(4)]?.kcal || 0;
  if (name === 'fat') return FAT_IMPACT * Math.max(1, ctx.cookedCount || 1);
  if (name === 'eaten') return (ctx.kcal || 500) * 0.75;
  if (name === 'favorite') return ctx.kcal || 500;
  if (name === 'other_food') return 250;
  return 0;
}

/**
 * Split answers into accepted (silent) and ask (shown to the user, at most maxAsk).
 * @param {object} opts
 * @param {string[]} [opts.known]  food keys named in the note: present without asking
 * @returns {{accepted:Object<string,{value,confidence,source}>, ask:Array<{name,prompt,options,suggested,confidence,multi?}>}}
 */
export function gate(questions, answers, { threshold = DEFAULT_THRESHOLD, maxAsk = DEFAULT_MAX_ASK, ctx = {}, skip = [], known = [] } = {}) {
  const accepted = {};
  const unsure = [];
  const unsureFoods = [];
  for (const k of known) if (questions[`has_${k}`]) accepted[`has_${k}`] = { value: true, confidence: 1, source: 'note' };
  for (const [name, q] of Object.entries(questions)) {
    if (skip.includes(name) || accepted[name]) continue;
    const r = readAnswer(q, answers?.[name]);
    if (r.value == null) continue; // the API returned nothing for it; caller falls back
    if (r.confidence >= threshold) { accepted[name] = { value: r.value, confidence: r.confidence, source: 'model' }; continue; }
    if (name.startsWith('has_')) { unsureFoods.push({ name, key: name.slice(4), p: r.p, confidence: r.confidence }); continue; }
    if (name.startsWith('portion_')) r.value = expectedPortion(name.slice(8), r.probabilities) || r.value;
    unsure.push({ name, q, r, impact: questionImpact(name, ctx) * (1 - r.confidence) });
  }
  // portion questions only for foods already known to be on the plate (a food still in the
  // multi-select check falls back to its expected portion instead of spending a question)
  const likely = (n) => accepted[`has_${n.slice(8)}`]?.value === true;
  const candidates = unsure.filter((u) => !u.name.startsWith('portion_') || likely(u.name));
  for (const u of unsure) if (!candidates.includes(u)) accepted[u.name] = { value: u.r.value, confidence: u.r.confidence, source: 'model-low' };
  candidates.sort((a, b) => b.impact - a.impact || a.name.localeCompare(b.name));
  const ask = [];
  unsureFoods.sort((a, b) => b.p - a.p);
  const offered = unsureFoods.slice(0, MAX_CHECK_OPTIONS);
  if (offered.length && maxAsk > 0) {
    ask.push({
      name: 'items_check', multi: true, prompt: questionPrompt('items_check'),
      options: offered.map((u) => ({ value: u.key, label: FOOD_BY_KEY[u.key]?.name || u.key })),
      suggested: offered.filter((u) => u.p >= SUGGEST_P).map((u) => u.key),
      confidence: Math.round(Math.min(...offered.map((u) => u.confidence)) * 100) / 100,
    });
  }
  for (const u of unsureFoods) {
    if (offered.includes(u) && ask.length) continue; // decided by the multi-select
    accepted[u.name] = { value: u.p >= SUGGEST_P, confidence: u.confidence, source: 'model-low' };
  }
  for (const u of candidates) {
    if (ask.length < maxAsk) {
      ask.push({ name: u.name, prompt: questionPrompt(u.name, u.q), options: questionOptions(u.name, u.q), suggested: u.r.value, confidence: Math.round(u.r.confidence * 100) / 100 });
    } else {
      accepted[u.name] = { value: u.r.value, confidence: u.r.confidence, source: 'model-low' };
    }
  }
  return { accepted, ask };
}

/** Merge the user's taps into the decisions. picks: {name: value}; items_check: [keys]. */
export function applyPicks(decided, ask, picks = {}) {
  const out = { ...decided };
  const has = (n) => Object.prototype.hasOwnProperty.call(picks, n);
  for (const q of ask || []) {
    if (q.multi) {
      const chosen = has(q.name) ? picks[q.name] : q.suggested;
      const user = has(q.name);
      for (const o of q.options) {
        out[`has_${o.value}`] = { value: chosen.includes(o.value), confidence: user ? 1 : q.confidence, source: user ? 'user' : 'model-low' };
      }
      continue;
    }
    out[q.name] = { value: has(q.name) ? picks[q.name] : q.suggested, confidence: has(q.name) ? 1 : q.confidence, source: has(q.name) ? 'user' : 'model-low' };
  }
  return out;
}

/**
 * For an uncertain portion answer, the option closest to the probability-weighted portion
 * (less jumpy than the top option when the model spreads its bets: 0.4 "1 cup" / 0.3 "2+ cups"
 * reads as ~1.5 cups, not 1).
 */
export function expectedPortion(key, probabilities) {
  const f = FOOD_BY_KEY[key];
  if (!f || !probabilities) return null;
  let sum = 0; let wsum = 0;
  for (const p of f.portions) { const w = Number(probabilities[p.key]) || 0; sum += w * p.mult; wsum += w; }
  if (!wsum) return null;
  const m = sum / wsum;
  return f.portions.reduce((best, p) => (Math.abs(p.mult - m) < Math.abs(best.mult - m) ? p : best), f.portions[0]).key;
}

/** Food keys considered after stage 1 (present, or plausible enough to ask about). */
export function candidateKeys(identifyAnswers) {
  return FOODS.map((f) => f.key).filter((k) => Number(identifyAnswers?.[`has_${k}`]?.noul) >= CANDIDATE_CUTOFF);
}

/**
 * Turn the merged decisions (model + user) into items and totals.
 * @param {Object<string,{value,confidence,source}>} decided  name -> decision (user answers win)
 * @param {{favorites?:Array, coachItems?:Array}} extra
 */
export function resolveEstimate(decided, { favorites = [], coachItems = [] } = {}) {
  const get = (n) => decided[n]?.value;
  let items = [];
  const fav = typeof get('favorite') === 'string' && get('favorite') !== 'none' ? favorites.find((f) => `fav_${f.id}` === get('favorite')) : null;
  if (fav) {
    items = (fav.items || []).map((i) => ({ ...i, source: 'favorite', confidence: decided.favorite.confidence }));
  } else {
    for (const f of FOODS) {
      const d = decided[`has_${f.key}`];
      if (!d || d.value !== true) continue;
      const pd = decided[`portion_${f.key}`];
      const portion = pd?.value || f.portions[Math.min(1, f.portions.length - 1)].key;
      const c = (x, dflt) => (x ? (x.source === 'user' ? 1 : x.confidence ?? dflt) : dflt);
      items.push({ key: f.key, name: f.name, portion, source: pd?.source === 'user' || d.source === 'user' ? 'user' : 'decider',
        confidence: Math.round(Math.min(c(d, 0), c(pd, 0.5)) * 100) / 100 });
    }
  }
  for (const c of coachItems || []) {
    items.push({ key: null, name: String(c.name || 'Item').slice(0, 80), portion: String(c.portion || '').slice(0, 40),
      custom: { kcal: +c.kcal || 0, protein_g: +c.protein_g || 0, carbs_g: +c.carbs_g || 0, fat_g: +c.fat_g || 0 }, source: 'coach', confidence: c.confidence ?? 0.5 });
  }
  const fat = get('fat') || 'a_little';
  const eaten = get('eaten') || 'all';
  const totals = mealNutrition(items, { fat, eaten });
  // meal confidence = mean over what the numbers depend on: each item (presence x portion,
  // or the coach's own confidence), plus the fat and amount-eaten answers; user taps count as 1
  const dc = (d) => (d ? (d.source === 'user' ? 1 : d.confidence ?? 0) : null);
  const confs = items.map((i) => i.confidence ?? 0.5)
    .concat([dc(decided.fat), dc(decided.eaten)].filter((c) => c != null));
  const confidence = confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100 : 0;
  const sources = new Set(items.map((i) => i.source));
  const estimate_source = sources.has('coach') && sources.size > 1 ? 'decider+coach'
    : sources.has('coach') ? 'coach' : fav ? 'favorite' : 'decider';
  return { ...totals, fat, eaten, confidence, estimate_source };
}

/** Does the meal need the coach to name items the table doesn't know? */
export function needsCoach(decided) {
  if (decided.favorite && decided.favorite.value && decided.favorite.value !== 'none') return false;
  const anyKnown = Object.entries(decided).some(([n, d]) => n.startsWith('has_') && d.value === true);
  return decided.other_food?.value === true || !anyKnown;
}

// ---------------------------------------------------------------- mock decider (tests / demo)
const choiceAnswer = (criteria, probs) => {
  const keys = Object.keys(criteria);
  const p = Object.fromEntries(keys.map((k) => [k, probs[k] ?? 0]));
  const sum = Object.values(p).reduce((a, b) => a + b, 0) || 1;
  for (const k of keys) p[k] /= sum;
  const top = keys.reduce((a, b) => (p[b] > p[a] ? b : a), keys[0]);
  const n = keys.length;
  const confidence = n > 1 ? Math.max(0, (p[top] - 1 / n) / (1 - 1 / n)) : 1;
  return { type: 'choice', choice: top, confidence, probabilities: p };
};

/**
 * Deterministic stand-in for the Decisions API, driven by the note text. Foods named in the
 * note are "present" (no note: dal + rice). The first present food's portion is uncertain;
 * fat is uncertain unless the note mentions it; "half"/"most" set the amount eaten;
 * "mystery"/"something new" make other_food yes.
 */
export function mockDecide(request) {
  const note = String(request?.state?.note || '').toLowerCase();
  let present = foodsInText(note);
  if (!present.length && !/mystery|something new|unknown/.test(note)) present = ['dal', 'rice'];
  const answers = {};
  const unsure = /thali/.test(note) ? { sabzi: 0.72, salad: 0.68, sambar: 0.55, dosa: 0.4 } : {};
  for (const [name, q] of Object.entries(request.questions || {})) {
    if (name.startsWith('has_')) answers[name] = { type: 'noul', noul: unsure[name.slice(4)] ?? (present.includes(name.slice(4)) ? 0.96 : 0.03) };
    else if (name === 'other_food') answers[name] = { type: 'noul', noul: /mystery|something new|unknown/.test(note) ? 0.92 : 0.06 };
    else if (name === 'favorite') answers[name] = choiceAnswer(q.criteria, { none: 0.9 });
    else if (name.startsWith('portion_')) {
      const keys = Object.keys(q.criteria);
      const first = present[0] === name.slice(8);
      answers[name] = first ? choiceAnswer(q.criteria, { [keys[0]]: 0.2, [keys[1]]: 0.4, [keys[2]]: 0.3, [keys[3] || keys[0]]: 0.1 })
        : choiceAnswer(q.criteria, { [keys[1] || keys[0]]: 0.93 });
    } else if (name === 'fat') {
      answers[name] = /ghee|butter|fried|oily|deep/.test(note) ? choiceAnswer(q.criteria, { a_lot: 0.9, a_little: 0.08 })
        : /no oil|steamed|boiled|dry/.test(note) ? choiceAnswer(q.criteria, { none: 0.9 })
          : choiceAnswer(q.criteria, { none: 0.2, a_little: 0.5, a_lot: 0.3 });
    } else if (name === 'eaten') {
      answers[name] = /\bhalf\b/.test(note) ? choiceAnswer(q.criteria, { half: 0.9 }) : /\bmost\b/.test(note) ? choiceAnswer(q.criteria, { most: 0.9 }) : choiceAnswer(q.criteria, { all: 0.94 });
    } else if (q.type === 'noul') answers[name] = { type: 'noul', noul: 0.5 };
    else answers[name] = choiceAnswer(q.criteria || { x: null }, {});
  }
  return { model: request.model || DEFAULT_MODEL, answers, usage: { input_tokens: 0, output_tokens: Object.keys(answers).length }, mock: true };
}
