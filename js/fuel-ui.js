// Fuel tab UI (phone + desk). Rendering only; the pipeline lives in fuel.js.
import { MEALS, MAIN_MEALS, MEAL_LABELS, guessMeal, portionLabel } from './fuel-nutrition.js';
import { preparePhoto } from './fuel-decide.js';
import {
  dayTotals, streak, weeklyAdherence, weightTrend, repeatCandidates, favoriteFromMeal, localDate, addDays,
} from './fuel.js';
import { itemsText } from './fuel-log.js';
import { drawLine, cssVar } from './charts.js';
import { channelFor } from './channels.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * @param {object} ctx { fuel, db, getSettings, saveSettings, toast, esc, isDemo, isStale, coachReady, onRedraw }
 */
export function createFuelUi(ctx) {
  const { fuel, db, esc, toast } = ctx;
  const ui = { draft: null, picks: {}, seq: 0 };

  const ESTIMATE_CHIP = {
    queued: ['Waiting to estimate', 'coach-pending'],
    estimating: ['Estimating…', 'coach-sending'],
    needs_answers: ['Needs a quick check', 'coach-pending'],
    failed: ['Estimate failed · will retry', 'coach-failed'],
  };
  const COACH_CHIP = {
    sent: ['Coach ✓', 'coach-sent'], sending: ['Sending…', 'coach-sending'], failed: ['Coach: not sent', 'coach-failed'],
    'no-channel': ['No food channel', 'coach-none'], pending: ['Waiting to send', 'coach-pending'],
  };

  function chip(label, cls, title = '') {
    return `<span class="chip coach-chip ${cls}"${title ? ` title="${esc(title)}"` : ''}><span class="dot"></span>${esc(label)}</span>`;
  }

  function bar(value, target, color) {
    const pct = target ? Math.min(100, Math.round((value / target) * 100)) : 0;
    return `<div class="fuel-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%;background:${color}"></span></div>`;
  }

  // ------------------------------------------------------------------ render
  async function render() {
    const seq = ++ui.seq;
    const s = ctx.getSettings();
    const [mealsAll, weighins] = await Promise.all([db.getAll('meals'), db.getAll('weighins')]);
    if (seq !== ui.seq || ctx.isStale()) return;
    const meals = mealsAll.filter((m) => !m.deleted);
    const today = localDate();
    const t = dayTotals(meals, today);
    const st = streak(meals, today);
    const wk = weeklyAdherence(meals, today);
    const wt = weightTrend(weighins, today);
    const current = guessMeal();
    const todayMeals = meals.filter((m) => m.date === today).sort((a, b) => b.time.localeCompare(a.time) || b.createdAt - a.createdAt);
    const pendingQs = meals.filter((m) => m.estimate?.state === 'needs_answers').sort((a, b) => a.createdAt - b.createdAt);
    const repeats = repeatCandidates(meals, today, current);
    const favs = (s.fuelFavorites || []).slice(0, 6);
    const foodCh = channelFor(s, 'food');
    const proposed = s.fuelProposedTargets;
    const recentDays = Array.from({ length: 7 }, (_, i) => addDays(today, -i - 1)).map((d) => ({ d, ...dayTotals(meals, d) })).filter((r) => r.logged || r.skipped);
    const el = $('#screen-fuel');
    el.innerHTML = `
      <div class="page-head">
        <div><div class="eyebrow">Fuel</div><h1>Today</h1></div>
        <div class="head-actions muted small">${esc(new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))}</div>
      </div>
      ${proposed ? `<div class="banner ok" id="fuel-proposed"><div><strong>Coach suggests new targets:</strong> ${proposed.kcal} kcal · ${proposed.protein_g} g protein</div>
        <div class="banner-actions"><button class="btn small primary" id="fuel-accept-targets">Use them</button><button class="btn small ghost" id="fuel-dismiss-targets">Dismiss</button></div></div>` : ''}
      ${s.decideMode === 'mock' ? '<div class="chip chip-quiet fuel-mode">Mock estimates (demo)</div>' : ''}
      <div class="fuel-grid">
        <div class="fuel-main">
          <div class="tiles fuel-tiles">
            <div class="tile"><span class="tile-label">Calories</span><span class="tile-value" id="fuel-kcal">${t.kcal}</span><span class="tile-unit">of ${s.fuelKcalTarget} kcal${t.pending ? ` · ${t.pending} estimating` : ''}</span>${bar(t.kcal, s.fuelKcalTarget, 'var(--z3)')}</div>
            <div class="tile"><span class="tile-label">Protein</span><span class="tile-value" id="fuel-protein">${t.protein_g}</span><span class="tile-unit">of ${s.fuelProteinTarget} g</span>${bar(t.protein_g, s.fuelProteinTarget, 'var(--z2)')}</div>
          </div>
          <label class="start-btn fuel-log-btn" id="fuel-log-btn">
            <input type="file" id="fuel-camera" accept="image/*" capture="environment" hidden>
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
            <span>Log food</span>
          </label>
          <div class="fuel-alt">
            <label class="btn small ghost"><input type="file" id="fuel-library" accept="image/*" hidden>Choose photo</label>
            <button type="button" class="btn small ghost" id="fuel-note-only">Note only</button>
          </div>
          <div id="fuel-composer"></div>
          ${repeats.length || favs.length ? `<div class="type-chips fuel-quick" id="fuel-quick">
            ${repeats.map((r) => `<button type="button" class="chip-btn" data-repeat="${esc(r.log_id)}">${esc(r.label)}</button>`).join('')}
            ${favs.map((f) => `<button type="button" class="chip-btn" data-fav="${esc(f.id)}">★ ${esc(f.name)}</button>`).join('')}
          </div>` : ''}
          ${pendingQs.map((m) => questionsCard(m)).join('')}
          <div class="card">
            <div class="card-head"><h2>Meals today</h2><span class="muted small">${t.logged} logged${t.skipped ? ` · ${t.skipped} skipped` : ''}</span></div>
            ${todayMeals.length ? `<ul class="fuel-meals">${todayMeals.map(mealRow).join('')}</ul>` : '<p class="muted">Nothing logged yet. Snap your next meal: one photo is enough.</p>'}
            <div class="btn-row fuel-skips">${MAIN_MEALS.filter((k) => !t.mains.includes(k)).map((k) => `<button type="button" class="btn small ghost" data-skip="${k}">Skipped ${MEAL_LABELS[k].toLowerCase()}</button>`).join('')}</div>
          </div>
        </div>
        <div class="fuel-side">
          <div class="tiles fuel-tiles">
            <div class="tile"><span class="tile-label">Streak</span><span class="tile-value" id="fuel-streak">${st}</span><span class="tile-unit">day${st === 1 ? '' : 's'} with every main meal logged</span></div>
            <div class="tile"><span class="tile-label">This week</span><span class="tile-value" id="fuel-week">${wk.complete}/7</span>
              <span class="fuel-dots" aria-label="Days with all main meals logged">${wk.flags.map((f, i) => `<i class="${f ? 'on' : ''}" title="${esc(wk.days[i])}"></i>`).join('')}</span></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Weight</h2><span class="muted small" id="fuel-wt-summary">${wt.latest != null ? `${wt.latest} lb${wt.change != null ? ` · ${wt.change > 0 ? '+' : ''}${wt.change} lb in 7 days` : ''}` : 'No weigh-ins this week'}</span></div>
            <div class="field-row"><label class="field"><span>Weigh-in (lb)</span><input type="number" id="fuel-lbs" inputmode="decimal" step="0.1" min="50" max="700" placeholder="${wt.latest ?? '175.0'}"></label><button type="button" class="btn small primary" id="fuel-weigh">Save</button></div>
            <canvas id="fuel-wt-chart" class="chart fuel-wt-chart" aria-label="Weight, last 7 days"></canvas>
          </div>
          ${recentDays.length ? `<div class="card"><h2>Last 7 days</h2><div class="table-wrap"><table class="table compact"><thead><tr><th>Day</th><th>kcal</th><th>Protein</th><th>Meals</th></tr></thead><tbody>
            ${recentDays.map((r) => `<tr><td>${esc(new Date(`${r.d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</td><td>${r.kcal}</td><td>${r.protein_g} g</td><td>${MAIN_MEALS.map((k) => (r.mains.includes(k) ? '●' : '○')).join(' ')}</td></tr>`).join('')}
          </tbody></table></div></div>` : ''}
          ${!foodCh?.sessionKey ? '<p class="muted small">Meals stay on this device until you add your coach’s food channel key in <a href="#/settings">Settings → Coach channels</a>.</p>' : ''}
        </div>
      </div>`;
    bind(el, meals);
    renderComposer();
    const draw = () => drawLine($('#fuel-wt-chart'), {
      points: wt.points.map((p, i) => ({ x: i, y: p.lbs, t: p.date })), color: cssVar('--z1'),
      label: (p) => new Date(`${p.t}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }), empty: 'Weigh in to see your 7-day trend',
    });
    ctx.onRedraw(draw);
    requestAnimationFrame(draw);
  }

  function mealRow(m) {
    const e = m.estimate || {};
    const label = `${MEAL_LABELS[m.meal] || m.meal} · ${m.time}`;
    if (m.status === 'skipped') {
      return `<li class="fuel-meal skipped" data-id="${esc(m.log_id)}"><div class="fuel-thumb empty">–</div><div class="fuel-meal-body"><div class="fuel-meal-title">${esc(label)}</div><div class="muted small">Skipped</div></div>
        <div class="fuel-meal-side">${coachChip(m)}<button type="button" class="btn small ghost" data-del="${esc(m.log_id)}" aria-label="Remove">✕</button></div></li>`;
    }
    const est = ESTIMATE_CHIP[e.state];
    const noNums = e.state === 'done' && e.estimate_source === 'none';
    const nums = noNums ? '<span class="muted">No estimate</span>' : e.state === 'done' ? `<span class="fuel-num">${e.kcal} kcal</span> · <span class="fuel-num">${e.protein_g} g protein</span>` : '';
    const conf = e.state === 'done' && !noNums && e.confidence != null ? `<span class="muted small" title="${esc(e.estimate_source || '')}"> · ${Math.round(e.confidence * 100)}% sure</span>` : '';
    return `<li class="fuel-meal" data-id="${esc(m.log_id)}" data-state="${esc(e.state || '')}">
      ${m.thumb ? `<img class="fuel-thumb" src="${m.thumb}" alt="">` : '<div class="fuel-thumb empty">✎</div>'}
      <div class="fuel-meal-body">
        <div class="fuel-meal-title">${esc(label)}${m.demo ? ' <span class="chip chip-quiet">Demo</span>' : ''}</div>
        <div class="small fuel-items">${esc(e.state === 'done' ? itemsText(m) : m.notes_raw || 'Photo')}</div>
        <div class="small">${nums}${conf}</div>
        ${e.coachNote ? `<div class="muted small">${esc(e.coachNote)}</div>` : ''}
      </div>
      <div class="fuel-meal-side">
        ${est ? chip(est[0], est[1], e.error || '') : coachChip(m)}
        ${e.state === 'done' && e.items?.length ? `<button type="button" class="btn small ghost" data-favsave="${esc(m.log_id)}" title="Save as favourite">★</button>` : ''}
        <button type="button" class="btn small ghost" data-del="${esc(m.log_id)}" aria-label="Delete meal">✕</button>
      </div>
    </li>`;
  }

  function coachChip(m) {
    const c = m.coach?.status;
    if (m.demo && c !== 'sent') return '';
    const v = COACH_CHIP[c];
    return v ? chip(v[0], v[1], m.coach?.error || '') : '';
  }

  function questionsCard(m) {
    const qs = m.estimate.ask || [];
    const picks = (ui.picks[m.log_id] = ui.picks[m.log_id] || {});
    for (const q of qs) if (q.multi && !Object.prototype.hasOwnProperty.call(picks, q.name)) picks[q.name] = [...(q.suggested || [])];
    const hasMulti = qs.some((q) => q.multi);
    return `<div class="card fuel-questions" data-qid="${esc(m.log_id)}">
      <div class="card-head"><h2>Quick check · ${esc(MEAL_LABELS[m.meal] || m.meal)}</h2>${m.thumb ? `<img class="fuel-thumb small" src="${m.thumb}" alt="">` : ''}</div>
      ${qs.map((q) => `<div class="fuel-q" data-q="${esc(q.name)}"${q.multi ? ' data-multi="1"' : ''}><div class="fuel-q-prompt">${esc(q.prompt)}${q.multi ? ' <span class="muted small">(tap to change)</span>' : ''}</div>
        <div class="type-chips">${q.options.map((o) => {
          const on = q.multi ? (picks[q.name] || []).includes(o.value) : Object.prototype.hasOwnProperty.call(picks, q.name) && String(picks[q.name]) === String(o.value);
          return `<button type="button" class="chip-btn${on ? ' on' : ''}${String(o.value) === String(q.suggested) ? ' suggested' : ''}" data-opt="${esc(JSON.stringify(o.value))}" aria-pressed="${on}">${esc(o.label)}</button>`;
        }).join('')}</div></div>`).join('')}
      <div class="btn-row">${hasMulti ? `<button type="button" class="btn small primary" data-done="${esc(m.log_id)}">Done</button>` : ''}<button type="button" class="btn small ghost" data-guess="${esc(m.log_id)}">Use best guesses</button></div>
    </div>`;
  }

  function renderComposer() {
    const box = $('#fuel-composer');
    if (!box) return;
    const d = ui.draft;
    if (!d) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="card fuel-composer">
      <div class="fuel-composer-top">
        ${d.thumb ? `<img class="fuel-preview" src="${d.photo || d.thumb}" alt="Meal photo">` : '<div class="fuel-preview empty">No photo</div>'}
        <div class="fuel-composer-fields">
          <div class="type-chips" role="radiogroup" aria-label="Meal">${MEALS.map((k) => `<button type="button" class="chip-btn${d.meal === k ? ' on' : ''}" data-meal="${k}" aria-pressed="${d.meal === k}">${MEAL_LABELS[k]}</button>`).join('')}</div>
          <textarea id="fuel-note" rows="2" placeholder="Optional: “cooked in ghee”, “ate half”, “2 rotis”">${esc(d.note || '')}</textarea>
          <p class="hint small">Tap the box, then the 🎤 key to dictate.</p>
        </div>
      </div>
      <div class="btn-row"><button type="button" class="btn primary" id="fuel-save">Save</button><button type="button" class="btn ghost" id="fuel-cancel">Cancel</button></div>
    </div>`;
    $('#fuel-note').addEventListener('input', (e) => { d.note = e.target.value; });
    $$('[data-meal]', box).forEach((b) => { b.onclick = () => { d.meal = b.dataset.meal; renderComposer(); }; });
    $('#fuel-save').onclick = saveDraft;
    $('#fuel-cancel').onclick = () => { ui.draft = null; renderComposer(); };
    if (!d.thumb) setTimeout(() => $('#fuel-note')?.focus(), 30);
  }

  async function onPhoto(file) {
    if (!file) return;
    try {
      const { photo, thumb } = await preparePhoto(file);
      ui.draft = { photo, thumb, meal: guessMeal(), note: ui.draft?.note || '' };
      renderComposer();
    } catch (e) { toast(`Couldn’t read that photo: ${e.message}`, 4000); }
  }

  async function saveDraft() {
    const d = ui.draft;
    if (!d) return;
    if (!d.photo && !String(d.note || '').trim()) { toast('Add a photo or a note'); return; }
    ui.draft = null;
    const m = await fuel.logMeal({ photo: d.photo, thumb: d.thumb, note: d.note, meal: d.meal, demo: ctx.isDemo() });
    toast(navigator.onLine === false ? 'Saved · will estimate when you’re online' : 'Saved · estimating…');
    await render();
    ctx.afterMealSaved(m.log_id);
  }

  function bind(el, meals) {
    $('#fuel-camera').onchange = (e) => { onPhoto(e.target.files[0]); e.target.value = ''; };
    $('#fuel-library').onchange = (e) => { onPhoto(e.target.files[0]); e.target.value = ''; };
    $('#fuel-note-only').onclick = () => { ui.draft = { photo: null, thumb: null, meal: guessMeal(), note: '' }; renderComposer(); };
    $$('[data-repeat]', el).forEach((b) => { b.onclick = async () => {
      const m = await fuel.repeatMeal({ from: b.dataset.repeat, meal: guessMeal(), label: 'repeat', demo: ctx.isDemo() });
      toast('Logged'); await render(); ctx.afterMealSaved(m.log_id);
    }; });
    $$('[data-fav]', el).forEach((b) => { b.onclick = async () => {
      const f = (ctx.getSettings().fuelFavorites || []).find((x) => x.id === b.dataset.fav);
      if (!f) return;
      const m = await fuel.repeatMeal({ from: { ...f, items: f.items }, meal: guessMeal(), label: 'favorite', demo: ctx.isDemo() });
      toast(`Logged ${f.name}`); await render(); ctx.afterMealSaved(m.log_id);
    }; });
    $$('[data-skip]', el).forEach((b) => { b.onclick = async () => {
      const m = await fuel.skipMeal({ meal: b.dataset.skip, demo: ctx.isDemo() });
      toast(`Marked ${MEAL_LABELS[b.dataset.skip].toLowerCase()} skipped`); await render(); ctx.afterMealSaved(m.log_id);
    }; });
    $$('[data-del]', el).forEach((b) => { b.onclick = async () => {
      if (!confirm('Delete this meal?')) return;
      await fuel.deleteMeal(b.dataset.del); ctx.syncNow(); render();
    }; });
    $$('[data-favsave]', el).forEach((b) => { b.onclick = async () => {
      const m = meals.find((x) => x.log_id === b.dataset.favsave);
      if (!m) return;
      const name = prompt('Name this favourite', favoriteFromMeal(m).name);
      if (name == null) return;
      const s = ctx.getSettings();
      ctx.saveSettings({ fuelFavorites: [favoriteFromMeal(m, name), ...(s.fuelFavorites || [])].slice(0, 20) });
      toast('Saved to favourites'); render();
    }; });
    $$('.fuel-questions', el).forEach((card) => {
      const id = card.dataset.qid;
      $$('.fuel-q', card).forEach((qel) => {
        $$('[data-opt]', qel).forEach((b) => { b.onclick = async () => {
          const picks = (ui.picks[id] = ui.picks[id] || {});
          const v = JSON.parse(b.dataset.opt);
          if (qel.dataset.multi) {
            const set = new Set(picks[qel.dataset.q] || []);
            if (set.has(v)) set.delete(v); else set.add(v);
            picks[qel.dataset.q] = [...set];
            b.classList.toggle('on', set.has(v)); b.setAttribute('aria-pressed', set.has(v));
            return; // multi-select: submitted with Done
          }
          picks[qel.dataset.q] = v;
          $$('[data-opt]', qel).forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
          const m = meals.find((x) => x.log_id === id);
          if (m && !(m.estimate.ask || []).some((q) => q.multi) && (m.estimate.ask || []).every((q) => Object.prototype.hasOwnProperty.call(picks, q.name))) {
            delete ui.picks[id];
            await fuel.answer(id, picks);
            await render();
            ctx.afterMealSaved(id);
          }
        }; });
      });
      const g = $('[data-guess]', card);
      // best guesses: ignore any taps, use the model's suggestions
      if (g) g.onclick = async () => { delete ui.picks[id]; await fuel.answer(id, {}); await render(); ctx.afterMealSaved(id); };
      const done = $('[data-done]', card);
      if (done) done.onclick = async () => { const picks = ui.picks[id] || {}; delete ui.picks[id]; await fuel.answer(id, picks); await render(); ctx.afterMealSaved(id); };
    });
    $('#fuel-weigh').onclick = async () => {
      try {
        await fuel.logWeighIn({ lbs: $('#fuel-lbs').value, demo: ctx.isDemo() });
        toast('Weigh-in saved'); await render(); ctx.afterWeighIn();
      } catch (e) { toast(e.message, 3500); }
    };
    const acc = $('#fuel-accept-targets');
    if (acc) {
      acc.onclick = () => { const p = ctx.getSettings().fuelProposedTargets; ctx.saveSettings({ fuelKcalTarget: p.kcal, fuelProteinTarget: p.protein_g, fuelProposedTargets: null }); toast('Targets updated'); render(); };
      $('#fuel-dismiss-targets').onclick = () => { ctx.saveSettings({ fuelDismissedTargets: ctx.getSettings().fuelProposedTargets, fuelProposedTargets: null }); render(); };
    }
  }

  return { render, hasDraft: () => !!ui.draft };
}

export { portionLabel };
