// Local, dependency-free parser for dictated workout notes.
// "Upper body day. Bench 4 sets of 8 at 155, felt strong. Pull-ups 3 by 10.
//  Shoulders tight on the last set. Energy 7 out of 10, slept about 6 hours."
// -> type Strength, focus Upper body, Bench press 4×8 @155 lb, Pull-ups 3×10,
//    energy 7/10, sleep ~6 h, flag Shoulder tightness.

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, a: 1, an: 1, single: 1, couple: 2,
};

// Canonical exercise names and the phrases people say for them. Longer aliases first.
const EXERCISES = [
  ['Romanian deadlift', ['romanian deadlifts?', 'rdls?']],
  ['Incline bench press', ['incline bench(?: press)?', 'incline press']],
  ['Bench press', ['bench(?:ing)?(?: press(?:es)?)?', 'chest press']],
  ['Deadlift', ['deadlifts?', 'dead lifts?']],
  ['Front squat', ['front squats?']],
  ['Squat', ['back squats?', 'squats?', 'squatted']],
  ['Overhead press', ['overhead press(?:es)?', 'ohp', 'shoulder press(?:es)?', 'military press']],
  ['Pull-ups', ['pull[- ]?ups?']],
  ['Chin-ups', ['chin[- ]?ups?']],
  ['Push-ups', ['push[- ]?ups?', 'press[- ]?ups?']],
  ['Lat pulldown', ['lat pull[- ]?downs?', 'pull[- ]?downs?']],
  ['Row', ['bent[- ]over rows?', 'barbell rows?', 'dumbbell rows?', 'cable rows?', 'rows']],
  ['Lunges', ['walking lunges?', 'lunges?']],
  ['Bulgarian split squat', ['bulgarian split squats?', 'split squats?']],
  ['Leg press', ['leg press(?:es)?']],
  ['Hip thrust', ['hip thrusts?', 'glute bridges?']],
  ['Bicep curls', ['bicep curls?', 'biceps curls?', 'hammer curls?', 'curls?']],
  ['Tricep extensions', ['tricep(?:s)? extensions?', 'skull ?crushers?', 'tricep pushdowns?']],
  ['Dips', ['dips']],
  ['Lateral raises', ['lateral raises?', 'side raises?']],
  ['Kettlebell swings', ['kettlebell swings?', 'kb swings?', 'swings']],
  ['Step-ups', ['step[- ]?ups?']],
  ['Calf raises', ['calf raises?']],
  ['Plank', ['planks?']],
  ['Burpees', ['burpees?']],
  ['Box jumps', ['box jumps?']],
  ['Face pulls', ['face pulls?']],
  ['Farmer carry', ["farmer'?s? (?:carry|carries|walks?)"]],
];

const TYPE_KEYWORDS = {
  Strength: ['strength', 'lift', 'lifting', 'weights', 'upper body', 'lower body', 'leg day', 'push day', 'pull day', 'gym'],
  Run: ['run', 'ran', 'running', 'jog', 'jogging', 'treadmill', '5k', '10k', 'tempo run'],
  Cycling: ['bike', 'biking', 'cycle', 'cycling', 'ride', 'rode', 'peloton', 'spin', 'trainer'],
  HIIT: ['hiit', 'interval', 'intervals', 'tabata', 'circuit', 'emom', 'amrap', 'metcon'],
  Yoga: ['yoga', 'stretch', 'stretching', 'mobility', 'flow', 'vinyasa', 'pilates'],
};

const FOCUS = [
  ['Upper body', /\bupper[- ]body\b/], ['Lower body', /\blower[- ]body\b/], ['Full body', /\bfull[- ]body\b/],
  ['Legs', /\b(?:legs?|leg day)\b/], ['Push', /\bpush day\b/], ['Pull', /\bpull day\b/],
  ['Core', /\b(?:core|abs)\b/], ['Back', /\bback day\b/], ['Chest', /\bchest day\b/],
  ['Shoulders', /\bshoulder day\b/], ['Arms', /\barm day\b/], ['Cardio', /\bcardio\b/],
  ['Mobility', /\bmobility\b/], ['Intervals', /\bintervals?\b/], ['Endurance', /\b(?:endurance|long run|long ride|zone 2)\b/],
];

const BODY_PARTS = [
  ['Lower back', 'lower back'], ['Upper back', 'upper back'], ['Shoulder', 'shoulders?'], ['Knee', 'knees?'],
  ['Hip', 'hips?'], ['Elbow', 'elbows?'], ['Wrist', 'wrists?'], ['Ankle', 'ankles?'], ['Neck', 'neck'],
  ['Hamstring', 'hamstrings?|hammies'], ['Calf', 'calf|calves'], ['Quad', 'quads?'], ['Glute', 'glutes?'],
  ['Chest', 'chest|pecs?'], ['Back', 'back'], ['Foot', 'foot|feet'], ['Shin', 'shins?'], ['Groin', 'groin'],
];

const FLAG_WORDS = [
  ['tightness', 'tight(?:ness)?|stiff(?:ness)?'],
  ['pain', 'pain(?:ful)?|hurt(?:s|ing)?|aching|ache[sd]?|twinge'],
  ['soreness', 'sore(?:ness)?'],
  ['tweak', 'tweak(?:ed)?|strain(?:ed)?|pull(?:ed)? (?:a )?muscle'],
  ['cramp', 'cramp(?:s|ed|ing)?'],
  ['dizziness', 'dizz(?:y|iness)|light[- ]?headed'],
  ['fatigue', 'tired|exhausted|fatigued?|drained|wiped'],
];

export function wordsToNumbers(text) {
  let t = ` ${text} `;
  // "six and a half" -> "6.5"
  t = t.replace(/\b(\w+) and a half\b/gi, (m, w) => {
    const n = toNum(w);
    return n == null ? m : String(n + 0.5);
  });
  // "one fifty five" (weights) -> 155 ; "one fifty" -> 150 ; "two twenty five" -> 225
  t = t.replace(/\b(one|two|three|four)[- ](twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](one|two|three|four|five|six|seven|eight|nine))?\b/gi,
    (m, h, tens, ones) => String(NUMBER_WORDS[h.toLowerCase()] * 100 + NUMBER_WORDS[tens.toLowerCase()] + (ones ? NUMBER_WORDS[ones.toLowerCase()] : 0)));
  // "twenty five" -> 25
  t = t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (m, a, b) => String(NUMBER_WORDS[a.toLowerCase()] + NUMBER_WORDS[b.toLowerCase()]));
  t = t.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi,
    (m) => String(NUMBER_WORDS[m.toLowerCase()]));
  return t.trim();
}

function toNum(w) {
  if (w == null) return null;
  const s = String(w).toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  return s in NUMBER_WORDS ? NUMBER_WORDS[s] : null;
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/**
 * @param {string} rawText
 * @param {{unit?: 'lb'|'kg', type?: string}} [opts]
 */
export function parseNotes(rawText, opts = {}) {
  const defaultUnit = opts.unit || 'lb';
  const original = String(rawText || '');
  const text = wordsToNumbers(original).replace(/[’‘]/g, "'");
  const lower = text.toLowerCase();
  const result = {
    type: null, focus: null, exercises: [], effort: null, energy: null,
    sleepHours: null, distance: null, flags: [], chips: [],
  };
  if (!lower.trim()) return result;

  // ---- exercises -------------------------------------------------------
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    const s = sentence.toLowerCase();
    const hits = [];
    for (const [name, aliases] of EXERCISES) {
      const re = new RegExp(`\\b(?:${aliases.join('|')})\\b`, 'gi');
      let m;
      while ((m = re.exec(s))) {
        // skip if overlapping a longer hit already found
        if (hits.some((h) => m.index < h.end && m.index + m[0].length > h.start)) continue;
        hits.push({ name, start: m.index, end: m.index + m[0].length });
      }
    }
    hits.sort((a, b) => a.start - b.start);
    hits.forEach((hit, idx) => {
      const segEnd = idx + 1 < hits.length ? hits[idx + 1].start : s.length;
      const seg = s.slice(hit.end, segEnd);
      const before = s.slice(Math.max(0, hit.start - 24), hit.start);
      result.exercises.push(parseExerciseSegment(hit.name, seg, before, defaultUnit));
    });
  }
  // de-duplicate identical labels
  const seen = new Set();
  result.exercises = result.exercises.filter((e) => (seen.has(e.label) ? false : (seen.add(e.label), true)));

  // ---- type ------------------------------------------------------------
  const scores = {};
  for (const [type, words] of Object.entries(TYPE_KEYWORDS)) {
    scores[type] = words.reduce((acc, w) => acc + countMatches(lower, new RegExp(`\\b${escapeRe(w)}\\b`, 'g')), 0);
  }
  if (result.exercises.length) scores.Strength = (scores.Strength || 0) + result.exercises.length;
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  result.type = best && best[1] > 0 ? best[0] : (opts.type || null);

  // ---- focus -----------------------------------------------------------
  for (const [label, re] of FOCUS) {
    if (re.test(lower)) { result.focus = label; break; }
  }

  // ---- effort / energy -------------------------------------------------
  const tenRe = /(?:(rpe|effort|difficulty|intensity|exertion|energy|felt like|about|around|maybe)\s*(?:was|level|of|at|is|:)?\s*(?:a|an|like|around|about)?\s*)?(\d+(?:\.\d+)?)\s*(?:out of|\/|of)\s*10\b/gi;
  let m10;
  while ((m10 = tenRe.exec(lower))) {
    const kw = (m10[1] || '').toLowerCase();
    const val = parseFloat(m10[2]);
    if (!(val >= 0 && val <= 10)) continue;
    const ctx = lower.slice(Math.max(0, m10.index - 20), m10.index);
    if (kw === 'energy' || /energy\s*$/.test(ctx)) { if (result.energy == null) result.energy = val; }
    else if (result.effort == null) result.effort = val;
  }
  if (result.effort == null) {
    const rpe = /\b(?:rpe|effort)\s*(?:was|of|at|:)?\s*(\d+(?:\.\d+)?)\b/i.exec(lower);
    if (rpe && parseFloat(rpe[1]) <= 10) result.effort = parseFloat(rpe[1]);
  }

  // ---- sleep -----------------------------------------------------------
  const sleepPatterns = [
    /\bslept\s*(?:for\s*)?(?:about|around|maybe|roughly|only|like|~|approximately|just)?\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i,
    /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:of\s*)?sleep\b/i,
    /\bsleep\s*(?:was|:)?\s*(?:about|around|~)?\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)?\b/i,
  ];
  for (const re of sleepPatterns) {
    const sm = re.exec(lower);
    if (sm) {
      const h = parseFloat(sm[1]);
      if (h > 0 && h <= 14) { result.sleepHours = h; break; }
    }
  }

  // ---- distance (runs / rides) -----------------------------------------
  const dm = /\b(\d+(?:\.\d+)?)\s*(km|k|kilometers?|kilometres?|miles?|mi)\b/i.exec(lower);
  if (dm && !/\bkg\b/.test(dm[0])) {
    const unit = /^(km|k|kilomet)/i.test(dm[2]) ? 'km' : 'mi';
    result.distance = { value: parseFloat(dm[1]), unit, label: `${fmtNum(parseFloat(dm[1]))} ${unit}` };
  }

  // ---- flags -----------------------------------------------------------
  for (const clause of splitClauses(text)) {
    const c = clause.toLowerCase();
    for (const [kind, pattern] of FLAG_WORDS) {
      const fre = new RegExp(`\\b(?:${pattern})\\b`, 'i');
      const fm = fre.exec(c);
      if (!fm) continue;
      if (kind === 'fatigue' && /\bnot (?:too |that |very )?(?:tired|exhausted)/.test(c)) continue;
      if (/\bno (?:pain|soreness|tightness)\b/.test(c) || /\bpain[- ]free\b/.test(c)) continue;
      let part = null;
      for (const [label, pre] of BODY_PARTS) {
        if (new RegExp(`\\b(?:${pre})\\b`, 'i').test(c)) { part = label; break; }
      }
      // "back" also appears in "came back", "back to"; require it near the flag word
      if (part === 'Back' && !/\b(?:my|lower|upper|the)\s+back\b|\bback\s+(?:is|was|felt|feels|tight|sore|pain)/.test(c)) part = null;
      const label = part ? `${part} ${kind}` : capitalize(kind);
      if (!result.flags.some((f) => f.label === label)) result.flags.push({ kind, part, label });
    }
  }

  // ---- chips -------------------------------------------------------------
  if (result.type) result.chips.push({ kind: 'type', label: `Type: ${result.type}` });
  if (result.focus) result.chips.push({ kind: 'focus', label: `Focus: ${result.focus}` });
  for (const e of result.exercises) result.chips.push({ kind: 'exercise', label: e.label });
  if (result.distance) result.chips.push({ kind: 'distance', label: `Distance ${result.distance.label}` });
  if (result.effort != null) result.chips.push({ kind: 'effort', label: `Effort ${fmtNum(result.effort)}/10` });
  if (result.energy != null) result.chips.push({ kind: 'energy', label: `Energy ${fmtNum(result.energy)}/10` });
  if (result.sleepHours != null) result.chips.push({ kind: 'sleep', label: `Sleep ~${fmtNum(result.sleepHours)} h` });
  for (const f of result.flags) result.chips.push({ kind: 'flag', label: `Flag: ${f.label.toLowerCase().replace(/^./, (x) => x.toUpperCase())}` });
  return result;
}

function parseExerciseSegment(name, seg, before, defaultUnit) {
  const ex = { name, sets: null, reps: null, weight: null, unit: null, label: name };
  let m;
  if ((m = /(\d+)\s*sets?\s*(?:of|x|×|by)\s*(\d+)/.exec(seg))) { ex.sets = +m[1]; ex.reps = +m[2]; }
  else if ((m = /(\d+)\s*(?:x|×|by|times)\s*(\d+)\b/.exec(seg))) { ex.sets = +m[1]; ex.reps = +m[2]; }
  else if ((m = /(\d+)\s*sets?\b/.exec(seg))) {
    ex.sets = +m[1];
    const r = /(\d+)\s*reps?\b/.exec(seg);
    if (r) ex.reps = +r[1];
  } else if ((m = /(\d+)\s*reps?\b/.exec(seg))) { ex.reps = +m[1]; }
  else if ((m = /(\d+)\s*sets?\s*$/.exec(before)) ) { ex.sets = +m[1]; }

  const wm = /(?:\bat|@|\bwith|\busing)\s*(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kgs?|kilos?|kilograms?)?/.exec(seg)
    || /(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kgs?|kilos?|kilograms?)\b/.exec(seg);
  if (wm) {
    const w = parseFloat(wm[1]);
    if (w > 0 && w < 2000 && !(ex.reps === w && !wm[2])) {
      ex.weight = w;
      ex.unit = wm[2] ? (/^k/i.test(wm[2]) ? 'kg' : 'lb') : defaultUnit;
    }
  }
  let label = name;
  if (ex.sets && ex.reps) label += ` ${ex.sets}×${ex.reps}`;
  else if (ex.sets) label += ` ${ex.sets} sets`;
  else if (ex.reps) label += ` ${ex.reps} reps`;
  if (ex.weight) label += ` @${fmtNum(ex.weight)} ${ex.unit}`;
  ex.label = label;
  return ex;
}

function splitSentences(text) {
  return text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}
function splitClauses(text) {
  return text.split(/[.!?;\n]+|,\s*(?:and\s+)?|\bbut\b/).map((s) => s.trim()).filter(Boolean);
}
function countMatches(s, re) { return (s.match(re) || []).length; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
