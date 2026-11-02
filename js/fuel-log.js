// Builds the "PULSE MEAL LOG v1" message Pulse posts into the coach's FOOD channel for each
// logged meal (or skipped meal) and each weigh-in, plus the Supabase rows. Pure functions.
//
// Message layout (plain text, one user message, same shape as PULSE WORKOUT LOG v1):
//   PULSE MEAL LOG v1
//   log_id: <uuid> · revision: <n> · record: meal|weigh_in
//   <instruction line for the coach>
//   Summary
//   <human lines>
//   Data
//   ```json
//   { format: "pulse-meal-log", version: 1, record: "meal", ... }
//   ```
//
// Meal JSON top-level fields mirror the coach's health.sqlite3 `meals` row (date, time, items,
// source) plus additive columns (log_id, revision, meal, notes_raw, kcal, protein_g, carbs_g,
// fat_g, estimate_source, confidence, status logged|skipped, answers_json). Weigh-ins mirror
// `weigh_ins` (date, lbs, note) plus log_id / revision. Photos are never included.

import { isoLocal, localTimeZone } from './workout-log.js';
import { MEAL_LABELS, portionLabel } from './fuel-nutrition.js';

export const MEAL_LOG_HEADER = 'PULSE MEAL LOG v1';
export const MEAL_LOG_FORMAT = 'pulse-meal-log';
export const MEAL_LOG_VERSION = 1;

export const isDemoEntry = (e) => !!(e && (e.demo || e.source === 'demo'));

/** Coach `meals.items` text: "Dal 1 cup, Rice 1½ cups, Roti 2 pieces". */
export function itemsText(meal) {
  if (meal.status === 'skipped') return 'Skipped';
  const items = meal.estimate?.items || [];
  if (!items.length) return meal.notes_raw ? `(estimating) ${meal.notes_raw}` : '(photo, estimating)';
  return items.map((i) => `${i.name}${i.key ? ` ${portionLabel(i.key, i.portion)}` : i.portion ? ` ${i.portion}` : ''}`).join(', ');
}

export function mealLogData(meal, { revision = meal.revision || 1, now = Date.now() } = {}) {
  const e = meal.estimate || {};
  const done = e.state === 'done' && e.estimate_source !== 'none'; // 'none' = logged without numbers
  return {
    format: MEAL_LOG_FORMAT,
    version: MEAL_LOG_VERSION,
    record: 'meal',
    log_id: meal.log_id,
    revision,
    generated_at: isoLocal(now),
    timezone: localTimeZone(),
    // ---- coach health.sqlite3 `meals` columns (existing)
    date: meal.date,
    time: meal.time,
    items: itemsText(meal),
    source: isDemoEntry(meal) ? 'demo' : 'pulse',
    // ---- additive columns
    meal: meal.meal,
    status: meal.status === 'skipped' ? 'skipped' : 'logged',
    notes_raw: meal.notes_raw || null,
    kcal: done ? e.kcal ?? null : null,
    protein_g: done ? e.protein_g ?? null : null,
    carbs_g: done ? e.carbs_g ?? null : null,
    fat_g: done ? e.fat_g ?? null : null,
    estimate_source: meal.status === 'skipped' ? null : (e.state === 'done' ? e.estimate_source : 'pending'),
    confidence: done ? e.confidence ?? null : null,
    answers_json: meal.status === 'skipped' ? null : {
      items: (e.items || []).map((i) => ({ key: i.key, name: i.name, portion: i.portion, kcal: i.kcal, protein_g: i.protein_g, carbs_g: i.carbs_g, fat_g: i.fat_g, source: i.source, confidence: i.confidence })),
      fat: e.fat ?? null, eaten: e.eaten ?? null,
      decided: e.decided || null, model: e.model || null, threshold: e.threshold ?? null,
    },
    photo: meal.hasPhoto ? 'kept on device only' : null,
  };
}

export function weighInData(w, { revision = w.revision || 1, now = Date.now() } = {}) {
  return {
    format: MEAL_LOG_FORMAT,
    version: MEAL_LOG_VERSION,
    record: 'weigh_in',
    log_id: w.log_id,
    revision,
    generated_at: isoLocal(now),
    timezone: localTimeZone(),
    date: w.date,
    time: w.time,
    lbs: w.lbs,
    note: w.note || null,
    source: isDemoEntry(w) ? 'demo' : 'pulse',
  };
}

export function mealCoachInstruction(d) {
  if (d.source === 'demo') {
    return 'Coach: this is a DEMO / CONNECTION TEST (source=demo). Do NOT insert it into health.sqlite3 and do not change any targets. Just confirm you received it in one sentence.';
  }
  if (d.record === 'weigh_in') {
    return `Coach: upsert days for ${d.date} first, then upsert weigh_ins by log_id (same log_id = update that row, never a duplicate) with date, lbs and note. `
      + 'Then reply with one or two sentences on the trend.';
  }
  return `Coach: upsert days for ${d.date} first, then upsert meals by log_id (same log_id = update that row, never a duplicate) `
    + 'with date, time, items, source and the extra columns (meal, status, notes_raw, kcal, protein_g, carbs_g, fat_g, estimate_source, confidence, answers_json). '
    + 'Pulse computed the numbers from a fixed nutrition table plus model answers; correct them only if clearly wrong and say so. '
    + 'If you think my calorie/protein targets should change, propose them on a line "TARGETS: kcal=<n> protein_g=<n>". '
    + 'Then reply with a 1–2 sentence takeaway for me.';
}

function mealSummary(d) {
  const lines = [`- ${MEAL_LABELS[d.meal] || d.meal} · ${d.date} ${d.time} (${d.timezone})`];
  if (d.status === 'skipped') { lines.push('- Skipped this meal'); return lines.join('\n'); }
  lines.push(`- Items: ${d.items}`);
  if (d.kcal != null) lines.push(`- Estimate: ~${d.kcal} kcal · protein ${d.protein_g} g · carbs ${d.carbs_g} g · fat ${d.fat_g} g (${d.estimate_source}, confidence ${d.confidence})`);
  if (d.notes_raw) lines.push(`- Note: "${d.notes_raw.replace(/\s+/g, ' ')}"`);
  return lines.join('\n');
}

function build(d, human) {
  const head = `${MEAL_LOG_HEADER}\nlog_id: ${d.log_id} · revision: ${d.revision} · record: ${d.record}`;
  const text = `${head}\n\n${mealCoachInstruction(d)}\n\nSummary\n${human}\n\nData\n\`\`\`json\n${JSON.stringify(d)}\n\`\`\`\n`;
  return { text, summary: `${MEAL_LOG_HEADER}\n${human}`, data: d };
}

export function buildMealLog(meal, opts = {}) {
  const d = mealLogData(meal, opts);
  return build(d, mealSummary(d));
}

export function buildWeighInLog(w, opts = {}) {
  const d = weighInData(w, opts);
  return build(d, `- Weigh-in ${d.date} ${d.time}: ${d.lbs} lb${d.note ? ` ("${d.note}")` : ''}`);
}

export function parseMealLog(text) {
  if (!String(text).startsWith(MEAL_LOG_HEADER)) return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  return m ? JSON.parse(m[1]) : null;
}

/** "TARGETS: kcal=2100 protein_g=150" in a coach reply -> {kcal, protein_g} | null */
export function parseTargets(reply) {
  const m = /TARGETS:\s*kcal\s*=\s*(\d{3,5})\s+protein_g\s*=\s*(\d{2,3})/i.exec(String(reply || ''));
  return m ? { kcal: +m[1], protein_g: +m[2] } : null;
}

// ---------------------------------------------------------------- Supabase rows (schema v3)
export function supabaseMealRow(meal, userId) {
  const d = mealLogData(meal);
  const row = {
    log_id: d.log_id, revision: d.revision, date: d.date, time: d.time, items: d.items, source: d.source,
    meal: d.meal, status: d.status, notes_raw: d.notes_raw, kcal: d.kcal, protein_g: d.protein_g, carbs_g: d.carbs_g, fat_g: d.fat_g,
    estimate_source: d.estimate_source, confidence: d.confidence, answers_json: d.answers_json, deleted_at: null,
  };
  if (userId) row.user_id = userId;
  return row;
}

export function supabaseWeighInRow(w, userId) {
  const row = { log_id: w.log_id, revision: w.revision || 1, date: w.date, lbs: w.lbs, note: w.note || null, deleted_at: null };
  if (userId) row.user_id = userId;
  return row;
}

// ---------------------------------------------------------------- coach: name unknown items
export const COACH_ITEMS_HEADER = 'PULSE FOOD ID v1';

/** One user message (text + photo) asking the food coach to name items the table doesn't have. */
export function coachItemsMessage({ meal, note, photo, known = [] }) {
  const text = `${COACH_ITEMS_HEADER}\nCoach: identify the foods in this ${meal || 'meal'} photo that are NOT already in this list: ${known.join(', ') || '(none)'}. `
    + `Note from me: "${String(note || '').slice(0, 500)}". Do not log anything yet (Pulse sends the meal log separately). `
    + 'Reply ONLY with a fenced json block: {"items":[{"name":"...","portion":"e.g. 1 cup","kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"confidence":0.0}]} '
    + 'with totals for the portion shown. Use an empty list if there is nothing else.';
  const content = [{ type: 'text', text }];
  if (photo) content.push({ type: 'image_url', image_url: { url: photo } });
  return { role: 'user', content };
}

export function parseCoachItems(reply) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(String(reply || '')) || /(\{[\s\S]*"items"[\s\S]*\})/.exec(String(reply || ''));
  if (!m) return [];
  try {
    const j = JSON.parse(m[1]);
    return (Array.isArray(j.items) ? j.items : []).filter((i) => i && i.name && Number.isFinite(+i.kcal)).slice(0, 12)
      .map((i) => ({ name: String(i.name), portion: String(i.portion || ''), kcal: +i.kcal, protein_g: +i.protein_g || 0, carbs_g: +i.carbs_g || 0, fat_g: +i.fat_g || 0, confidence: Math.max(0, Math.min(1, +i.confidence || 0.5)) }));
  } catch { return []; }
}
