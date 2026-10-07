// Pulse — app shell, screens and glue.
import * as db from './db.js';
import { BleStrap, DemoStrap, bluetoothSupport, rememberedStrap } from './ble.js';
import { Recorder } from './recorder.js';
import { getSettings, saveSettings } from './settings.js';
import {
  zoneFor, zoneBpmBounds, zoneRangeLabel, ZONE_NAMES, fmtDuration, fmtDate, relativeDay,
  buildTrends, computePatterns, lapStats, summarizeSamples,
} from './stats.js';
import { parseNotes } from './notes-parser.js';
import { drawHrChart, drawBars, drawLine, drawScatter, zoneColors, cssVar } from './charts.js';
import { keepAwake, allowSleep, wakeState, onWakeChange } from './wakelock.js';
import { samplesToCsv, sessionBundle, download, fileStem, exportAll, importData } from './export.js';
import * as sync from './sync.js';
import {
  coachConfigured, sessionContext, trendContext, buildMessages, sendChat, sendToSession,
  autoSendEnabled, coachSessionKey, sessionKeyIssue,
} from './coach.js';
import { createCoachSync } from './coach-sync.js';
import { buildWorkoutLog } from './workout-log.js';
import { generateDemoHistory, removeDemoHistory } from './demo.js';

const TYPES = ['Strength', 'Run', 'Cycling', 'HIIT', 'Yoga', 'Other'];
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  routeSeq: 0,
  settings: getSettings(),
  strap: null,
  recorder: null,
  selectedType: localStorage.getItem('pulse.lastType') || null,
  connecting: null, // { firstHrAt, resumeSession }
  battery: null,
  lastHr: null,
  justSaved: null,
  range: '4w',
  redraw: null, // function to redraw the current screen's charts
  liveTimer: null,
  coach: null,
};
state.recorder = new Recorder(state.settings);

// Workout logs -> the user's OpenClaw coach session (see coach-sync.js).
const coachSync = createCoachSync({
  db,
  send: (settings, text) => sendToSession(settings, text),
  getSettings: () => state.settings,
  isConfigured: coachConfigured,
  buildLog: buildWorkoutLog,
  online: () => navigator.onLine !== false,
});

/** Called once a finished workout (and its notes, if any) is safely in IndexedDB. */
async function afterWorkoutSaved(id) {
  if (!autoSendEnabled(state.settings)) return;
  try {
    const rec = await coachSync.queue(id);
    if (rec?.status !== 'sent') coachSync.sendNow(id); // fire and forget; never blocks the UI
  } catch (e) { console.warn('could not queue coach log', e); }
}

// ------------------------------------------------------------------ utilities
const isStale = (seq) => seq !== state.routeSeq;

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

function isDemo() {
  return !!state.settings.demo || new URLSearchParams(location.search).has('demo');
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function zoneVar(z) { return `var(--z${z})`; }

function applyLayout() {
  const pref = state.settings.layout;
  const desk = pref === 'desk' || (pref === 'auto' && window.innerWidth >= 1024);
  document.body.classList.toggle('desk', desk);
  document.body.classList.toggle('phone', !desk);
  const btn = $('#layout-toggle');
  if (btn) {
    btn.textContent = desk ? 'Desk view' : 'Phone view';
    btn.setAttribute('aria-pressed', String(desk));
  }
}

function showScreen(name) {
  $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
  document.body.dataset.screen = name;
  const navName = ['start', 'connecting', 'live', 'notes'].includes(name) ? 'start' : name === 'session' ? 'dashboard' : name;
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === navName));
  state.redraw = null;
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ router
async function route() {
  state.routeSeq = (state.routeSeq || 0) + 1;
  const h = location.hash || '#/';
  if (!h.startsWith('#/')) return; // e.g. Supabase auth redirect fragment
  const [name = '', id] = h.slice(2).split('/');
  if (state.recorder.active && name !== 'live' && name !== 'connecting') {
    // A workout is running: keep the user on it (they can still open settings/dashboard).
    if (!['settings', 'dashboard', 'session'].includes(name)) { go('#/live'); return; }
  }
  switch (name) {
    case '': case 'start': return renderStart();
    case 'connecting': if (!state.connecting) return go('#/'); return showScreen('connecting');
    case 'live': if (!state.recorder.active) return go('#/'); return renderLive();
    case 'notes': return renderNotes(id);
    case 'session': return renderSession(id);
    case 'dashboard': return renderDashboard();
    case 'settings': return renderSettings();
    default: return go('#/');
  }
}

// ------------------------------------------------------------------ start
async function renderStart() {
  const seq = state.routeSeq;
  showScreen('start');
  $('#greeting').textContent = greeting();
  // type chips
  const chips = $('#type-chips');
  chips.innerHTML = TYPES.map((t) => `<button type="button" class="chip-btn${state.selectedType === t ? ' on' : ''}" data-type="${t}" aria-pressed="${state.selectedType === t}">${t}</button>`).join('');
  // demo toggle
  $('#demo-toggle').checked = isDemo();
  renderStrapChip();
  // last workout
  const sessions = (await db.listSessions()).filter((s) => s.status === 'complete');
  if (isStale(seq)) return;
  const last = sessions[0];
  const card = $('#last-card');
  if (last) {
    const notes = await db.get('notes', last.id);
    card.innerHTML = `<a href="#/session/${last.id}" class="last-link">
      <span class="eyebrow">Last workout</span>
      <span class="last-main">${esc(relativeDay(last.startedAt))} · ${esc(last.type || 'Workout')} · ${Math.round((last.durationS || 0) / 60)} min${last.summary?.avg ? ` · avg ${last.summary.avg} bpm` : ''}</span>
      ${notes?.text ? `<span class="last-note">${esc(notes.text.slice(0, 110))}${notes.text.length > 110 ? '…' : ''}</span>` : ''}
    </a>`;
    card.hidden = false;
  } else {
    card.innerHTML = '<span class="eyebrow">Welcome</span><span class="last-main">Your first workout will show up here.</span>';
    card.hidden = false;
  }
  // recovery
  const unfinished = state.recorder.active ? [] : await db.activeSessions();
  const banner = $('#recover-banner');
  if (unfinished.length) {
    const s = unfinished.sort((a, b) => b.startedAt - a.startedAt)[0];
    banner.innerHTML = `<div><strong>Unfinished workout</strong> from ${esc(relativeDay(s.startedAt))} ${new Date(s.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${fmtDuration(s.durationS)} recorded</div>
      <div class="banner-actions"><button class="btn small primary" id="recover-resume">Resume</button><button class="btn small" id="recover-save">Save it</button><button class="btn small ghost" id="recover-discard">Discard</button></div>`;
    banner.hidden = false;
    $('#recover-resume').onclick = () => handleStart({ resumeSession: s });
    $('#recover-save').onclick = async () => {
      const done = await Recorder.finalizeRecovered(s, state.settings);
      banner.hidden = true;
      go(`#/notes/${done.id}`);
    };
    $('#recover-discard').onclick = async () => {
      if (!confirm('Discard the unfinished workout? Its heart-rate data will be deleted.')) return;
      await db.deleteSessionLocal(s.id);
      banner.hidden = true;
      toast('Discarded');
    };
  } else {
    banner.hidden = true;
  }
  const bt = bluetoothSupport();
  const warn = $('#bt-warning');
  if (!bt.available && !isDemo()) {
    warn.innerHTML = 'This browser can’t use Bluetooth. Use <strong>Bluefy</strong> on iPhone or <strong>Chrome/Edge</strong> on desktop, or turn on the demo strap below.';
    warn.hidden = false;
  } else warn.hidden = true;
}

function renderStrapChip() {
  const chip = $('#strap-chip');
  if (isDemo()) { chip.innerHTML = '<span class="dot" style="background:var(--z2)"></span>Demo strap · simulated heart rate'; return; }
  const mem = rememberedStrap();
  if (mem?.name) {
    chip.innerHTML = `<span class="dot"></span>${esc(mem.name)} · last seen ${esc(relativeDay(mem.lastSeen).toLowerCase())}${mem.battery != null ? ` · battery ${mem.battery}%` : ''}`;
  } else {
    chip.innerHTML = '<span class="dot"></span>No strap paired yet · you’ll pick it on first start';
  }
}

// Must stay synchronous up to requestDevice() so the browser sees the tap gesture.
function handleStart({ resumeSession = null } = {}) {
  if (state.recorder.active) { go('#/live'); return; }
  const demo = isDemo();
  const strap = demo ? new DemoStrap() : new BleStrap();
  bindStrap(strap);
  state.connecting = { firstHrAt: null, resumeSession, startedAt: Date.now() };
  resetConnectingUi();
  location.hash = '#/connecting';
  showScreen('connecting');
  keepAwake();
  const bt = bluetoothSupport();
  if (!demo && !bt.available) {
    connectingProblem('Web Bluetooth isn’t available here. On iPhone open Pulse in Bluefy; on a computer use Chrome or Edge. Or try the demo strap.');
    return;
  }
  if (!demo && bt.getDevices && rememberedStrap()?.id) {
    strap.connectSilently().then((ok) => {
      if (!ok && state.strap === strap) connectingProblem('Couldn’t reconnect automatically. Tap “Choose strap” to pick it.');
    });
  } else {
    strap.connectWithPicker().catch((e) => {
      if (state.strap === strap) connectingProblem(e?.name === 'NotFoundError' ? 'No strap chosen. Tap “Choose strap” to try again.' : `Couldn’t connect: ${e.message}`);
    });
  }
  hintTimer();
}

function hintTimer() {
  clearTimeout(hintTimer.t);
  hintTimer.t = setTimeout(() => { if (state.connecting && !state.connecting.firstHrAt) $('#connect-hint').classList.add('emph'); }, 10000);
}

function resetConnectingUi() {
  $$('#connect-steps li').forEach((li) => { li.className = ''; });
  $('#step-search').classList.add('active');
  $('#step-search .step-text').textContent = 'Looking for your strap…';
  $('#connect-problem').hidden = true;
  $('#pick-btn').hidden = true;
  $('#connect-hint').classList.remove('emph');
}

function connectingProblem(msg) {
  $('#connect-problem').textContent = msg;
  $('#connect-problem').hidden = false;
  $('#pick-btn').hidden = isDemo() || !bluetoothSupport().available;
}

function setStep(id, cls, text) {
  const li = $(`#${id}`);
  li.className = cls;
  if (text) $('.step-text', li).textContent = text;
}

function bindStrap(strap) {
  if (state.strap && state.strap !== strap) { try { state.strap.disconnect(); } catch { /* ignore */ } }
  state.strap = strap;
  strap.addEventListener('status', (ev) => {
    if (state.strap !== strap) return;
    const { state: st, message, device } = ev.detail;
    if (state.connecting && !state.recorder.active) {
      if (st === 'searching') setStep('step-search', 'active', message);
      if (st === 'connecting') { setStep('step-search', 'done', `Found ${device || 'your strap'}`); setStep('step-connect', 'active', message); }
      if (st === 'connected') {
        setStep('step-search', 'done', `Found ${device || 'your strap'}`);
        setStep('step-connect', 'done', 'Connected');
        setStep('step-hr', 'active', 'Waiting for heart rate…');
        $('#connect-problem').hidden = true; $('#pick-btn').hidden = true;
      }
    }
    if (state.recorder.active) {
      if (st === 'reconnecting') state.recorder.gapStart();
      if (st === 'connected') { state.recorder.gapEnd(); toast('Strap reconnected'); }
    }
    renderConnChip(st, message);
  });
  strap.addEventListener('battery', (ev) => { state.battery = ev.detail.level; renderConnChip(strap.state); });
  strap.addEventListener('hr', (ev) => {
    if (state.strap !== strap) return;
    const d = ev.detail;
    state.lastHr = d;
    if (state.connecting && !state.recorder.active && !state.connecting.firstHrAt && d.hr) {
      state.connecting.firstHrAt = Date.now();
      setStep('step-hr', 'done', `Receiving heart rate · ${d.hr} bpm`);
      setTimeout(beginLive, 700);
    }
    if (state.recorder.active) state.recorder.addSample(d);
    if (document.body.dataset.screen === 'live') renderLiveValues();
  });
}

async function beginLive() {
  if (!state.connecting || state.recorder.active) return;
  const { resumeSession } = state.connecting;
  const strap = state.strap;
  const device = { name: strap.name, id: strap.device?.id || null };
  if (resumeSession) await state.recorder.resume(resumeSession);
  else await state.recorder.start({ type: state.selectedType, device, source: isDemo() ? 'demo' : 'ble' });
  strap.keepAlive = true;
  state.connecting = null;
  go('#/live');
}

function cancelConnecting() {
  state.connecting = null;
  if (state.strap) { state.strap.disconnect(); state.strap = null; }
  allowSleep();
  go('#/');
}

// ------------------------------------------------------------------ live
function renderLive() {
  showScreen('live');
  $('#demo-dropout').hidden = !isDemo();
  $('#live-type').textContent = state.recorder.session?.type || 'Workout';
  renderZoneLegend();
  renderLiveValues();
  renderConnChip(state.strap?.state || 'connected');
  renderWake(wakeState());
  clearInterval(state.liveTimer);
  state.liveTimer = setInterval(() => {
    if (!state.recorder.active) { clearInterval(state.liveTimer); return; }
    $('#live-timer').textContent = fmtDuration(state.recorder.elapsedMs() / 1000);
  }, 250);
  state.redraw = () => drawLiveChart();
  drawLiveChart();
}

function renderLiveValues() {
  const rec = state.recorder;
  if (!rec.active) return;
  const s = state.settings;
  const hr = state.lastHr?.hr;
  const noContact = state.lastHr && state.lastHr.contact === false;
  const bpmEl = $('#live-bpm');
  bpmEl.textContent = hr ? String(hr) : '--';
  const z = hr ? zoneFor(hr, s.maxHr, s.zones) : 1;
  document.documentElement.style.setProperty('--zc', zoneVar(z));
  $('#live-zone').textContent = noContact ? 'No skin contact — wet the electrodes' : hr ? `Z${z} · ${ZONE_NAMES[z - 1]}` : 'Waiting…';
  $('#live-pct').textContent = hr ? `${Math.round((hr / s.maxHr) * 100)}% of max` : '';
  $('#live-timer').textContent = fmtDuration(rec.elapsedMs() / 1000);
  const sum = rec.liveSummary();
  $('#live-avg').textContent = sum.avg ?? '--';
  $('#live-max').textContent = sum.max ?? '--';
  $('#live-kcal').textContent = sum.calories ?? 0;
  $('#live-lap').textContent = `Lap ${rec.lapNo}`;
  const total = sum.zones.reduce((a, b) => a + b, 0) || 1;
  $('#live-zonebar').innerHTML = sum.zones.map((sec, i) => sec ? `<span style="width:${(sec / total) * 100}%;background:${zoneVar(i + 1)}" title="Z${i + 1} ${fmtDuration(sec)}"></span>` : '').join('');
  $$('#zone-legend [data-z]').forEach((el) => { $('.zl-time', el).textContent = fmtDuration(sum.zones[+el.dataset.z - 1]); });
  $('#pause-btn').textContent = rec.paused ? 'Resume' : 'Pause';
  document.body.classList.toggle('paused', rec.paused);
  drawLiveChart();
}

function drawLiveChart() {
  const c = $('#live-chart');
  if (!c || c.offsetParent === null) return;
  const rec = state.recorder;
  const s = state.settings;
  const now = rec.elapsedMs() / 1000;
  const laps = (rec.session?.laps || []).map((l) => l.elapsed_s);
  const gaps = (rec.session?.gaps || []).map((g) => ({ from: g.startElapsed, to: g.endElapsed ?? now }));
  c.dataset.font = document.body.classList.contains('desk') ? String(Math.max(14, Math.round(window.innerHeight * 0.019))) : '';
  drawHrChart(c, { points: rec.window, xMin: Math.max(0, now - 300), xMax: Math.max(now, 60), bounds: zoneBpmBounds(s.maxHr, s.zones), laps, gaps, live: true });
}

function renderZoneLegend() {
  const s = state.settings;
  $('#zone-legend').innerHTML = [1, 2, 3, 4, 5].map((z) => `<div data-z="${z}"><span class="sw" style="background:${zoneVar(z)}"></span><span class="zl-name">Z${z}<span class="zl-full"> ${ZONE_NAMES[z - 1]}</span></span><span class="zl-range">${zoneRangeLabel(z, s.maxHr, s.zones)}</span><span class="zl-time">0:00</span></div>`).join('');
}

function renderConnChip(st, message) {
  const el = $('#conn-chip');
  if (!el) return;
  const bat = state.battery != null ? ` · battery ${state.battery}%` : '';
  const name = state.strap?.name || 'Strap';
  el.classList.toggle('warn', st === 'reconnecting' || st === 'disconnected' || st === 'error');
  if (st === 'reconnecting') el.innerHTML = `<span class="dot pulse"></span>${esc(message || 'Reconnecting…')} · timer still running`;
  else if (st === 'connected') el.innerHTML = `<span class="dot ok"></span>${esc(name)} connected${bat}`;
  else if (st === 'disconnected') el.innerHTML = '<span class="dot"></span>Strap disconnected';
  else el.innerHTML = `<span class="dot"></span>${esc(message || st)}`;
}

function renderWake(ws) {
  const el = $('#wake-chip');
  if (!el) return;
  const on = ws.wakeLock || ws.bluefy;
  el.textContent = on ? 'Screen stays on' : 'Screen may sleep';
  el.classList.toggle('warn', !on && ws.wanted);
}
onWakeChange(renderWake);

let endArmed = null;
async function handleEnd() {
  const btn = $('#end-btn');
  if (!endArmed) {
    btn.textContent = 'Tap again to end';
    btn.classList.add('armed');
    endArmed = setTimeout(() => { endArmed = null; btn.textContent = 'End'; btn.classList.remove('armed'); }, 3500);
    return;
  }
  clearTimeout(endArmed); endArmed = null;
  btn.textContent = 'End'; btn.classList.remove('armed');
  clearInterval(state.liveTimer);
  const strap = state.strap;
  if (strap) { strap.keepAlive = false; strap.disconnect(); }
  state.strap = null;
  const done = await state.recorder.end();
  allowSleep();
  document.body.classList.remove('paused');
  if (done) go(`#/notes/${done.id}`); else go('#/');
}

// ------------------------------------------------------------------ notes
let recognition = null;
async function renderNotes(id) {
  const seq = state.routeSeq;
  const session = await db.get('sessions', id);
  if (isStale(seq)) return;
  if (!session) { toast('Workout not found'); return go('#/'); }
  showScreen('notes');
  const existing = await db.get('notes', id);
  if (isStale(seq)) return;
  $('#notes-summary').innerHTML = `${esc(session.type || 'Workout')} · ${fmtDuration(session.durationS)} · avg ${session.summary?.avg ?? '–'} · max ${session.summary?.max ?? '–'} bpm · ${session.summary?.calories ?? 0} kcal`;
  const ta = $('#notes-text');
  ta.value = existing?.text || '';
  ta.dataset.sessionId = id;
  updateParsed();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('#mic-btn').dataset.mode = SR ? 'speech' : 'keyboard';
  $('#mic-label').textContent = SR ? 'Dictate notes' : 'Dictate with keyboard';
}

function updateParsed() {
  const text = $('#notes-text').value;
  const parsed = parseNotes(text, { unit: state.settings.weightUnit === 'kg' ? 'kg' : 'lb' });
  $('#parsed-chips').innerHTML = parsed.chips.length
    ? parsed.chips.map((c) => `<span class="pchip pchip-${c.kind}">${esc(c.label)}</span>`).join('')
    : '<span class="muted">Type, exercises, sets × reps, effort, sleep and aches will show up here as you dictate.</span>';
  return parsed;
}

function toggleDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ta = $('#notes-text');
  if (!SR) {
    ta.focus();
    toast('Tap the microphone key on your keyboard to dictate', 3500);
    return;
  }
  if (recognition) { recognition.stop(); return; }
  recognition = new SR();
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  const baseText = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
  let finalText = '';
  recognition.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript.trim() + '. ';
      else interim += r[0].transcript;
    }
    ta.value = (baseText + finalText + interim).replace(/\.\s*\./g, '.');
    updateParsed();
  };
  recognition.onerror = (e) => { toast(`Dictation: ${e.error}. Use the keyboard mic instead.`, 3500); };
  recognition.onend = () => { recognition = null; $('#mic-btn').classList.remove('on'); $('#mic-label').textContent = 'Dictate notes'; };
  try {
    recognition.start();
    $('#mic-btn').classList.add('on');
    $('#mic-label').textContent = 'Listening… tap to stop';
  } catch (e) { recognition = null; ta.focus(); }
}

async function saveNotes() {
  const ta = $('#notes-text');
  const id = ta.dataset.sessionId;
  const parsed = updateParsed();
  const text = ta.value.trim();
  await db.put('notes', { sessionId: id, text, parsed, updatedAt: Date.now() });
  const session = await db.get('sessions', id);
  if (session) {
    if (!session.type && parsed.type) session.type = parsed.type;
    session.updatedAt = Date.now();
    await db.put('sessions', session);
  }
  if (recognition) recognition.stop();
  state.justSaved = id;
  sync.syncNow();
  await afterWorkoutSaved(id);
  go(`#/session/${id}`);
}

// ------------------------------------------------------------------ session detail
async function renderSession(id) {
  const seq = state.routeSeq;
  const session = await db.get('sessions', id);
  if (isStale(seq)) return;
  if (!session) { toast('Workout not found'); return go('#/dashboard'); }
  showScreen('session');
  const [samples, notes] = await Promise.all([db.getSamples(id), db.get('notes', id)]);
  if (isStale(seq)) return;
  const s = state.settings;
  const sum = session.summary || summarizeSamples(samples, s, session.pauses);
  const total = (sum.zones || []).reduce((a, b) => a + b, 0) || 1;
  const laps = lapStats(samples, session.laps);
  const justSaved = state.justSaved === id;
  state.justSaved = null;
  const autoSend = autoSendEnabled(s);
  const el = $('#screen-session');
  el.innerHTML = `
    ${justSaved ? `<div class="banner ok"><div><strong>Workout saved.</strong> <span id="saved-coach-note">${!coachConfigured(s) ? 'Set up your coach in Settings to get feedback.' : autoSend ? 'Sending it to your coach…' : 'Want your coach’s take?'}</span></div>
      <div class="banner-actions">${!coachConfigured(s) ? '<a class="btn small" href="#/settings">Coach settings</a>' : autoSend ? '' : '<button class="btn small primary" id="send-coach">Send to coach</button>'}</div></div>` : ''}
    <div class="page-head">
      <div>
        <div class="eyebrow">${session.status === 'active' ? 'In progress' : 'Workout'}</div>
        <h1>${esc(fmtDate(session.startedAt))} · ${esc(session.type || 'Workout')} · ${fmtDuration(session.durationS)}</h1>
        <div class="muted">${new Date(session.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${esc(session.device?.name || '')}${session.gaps?.length ? ` · ${session.gaps.length} signal gap${session.gaps.length > 1 ? 's' : ''}` : ''}</div>
        <div id="coach-log-status" class="coach-log-status"></div>
      </div>
      <div class="head-actions">
        <select id="session-type" aria-label="Workout type">${['', ...TYPES].map((t) => `<option value="${t}"${(session.type || '') === t ? ' selected' : ''}>${t || 'Set type…'}</option>`).join('')}</select>
        <button class="btn" id="open-coach">Coach</button>
      </div>
    </div>
    <div class="card chart-card"><canvas id="session-chart" class="chart chart-tall" aria-label="Heart rate over the session"></canvas></div>
    <div class="tiles">
      <div class="tile"><span class="tile-label">Avg</span><span class="tile-value">${sum.avg ?? '–'}</span><span class="tile-unit">bpm</span></div>
      <div class="tile"><span class="tile-label">Max</span><span class="tile-value">${sum.max ?? '–'}</span><span class="tile-unit">bpm</span></div>
      <div class="tile"><span class="tile-label">Min</span><span class="tile-value">${sum.min ?? '–'}</span><span class="tile-unit">bpm</span></div>
      <div class="tile"><span class="tile-label">Calories</span><span class="tile-value">${sum.calories ?? 0}</span><span class="tile-unit">kcal est.</span></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h2>Time in zones</h2>
        <div class="zonebar big">${(sum.zones || []).map((z, i) => z ? `<span style="width:${(z / total) * 100}%;background:${zoneVar(i + 1)}"></span>` : '').join('')}</div>
        <div class="zone-rows">${(sum.zones || []).map((z, i) => `<div class="zone-row"><span class="sw" style="background:${zoneVar(i + 1)}"></span><span>Z${i + 1} ${ZONE_NAMES[i]}</span><span class="muted">${zoneRangeLabel(i + 1, s.maxHr, s.zones)}</span><span class="num">${fmtDuration(z)}</span><span class="muted num">${Math.round((z / total) * 100)}%</span></div>`).join('')}</div>
        ${laps.length ? `<h2 class="mt">Laps / sets</h2><table class="table compact"><thead><tr><th>#</th><th>Start</th><th>Length</th><th>Avg</th><th>Max</th></tr></thead><tbody>
          ${laps.map((l) => `<tr><td>${l.lap}</td><td>${fmtDuration(l.startS)}</td><td>${fmtDuration(l.durationS)}</td><td>${l.avg}</td><td>${l.max}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>
      <div class="card">
        <div class="card-head"><h2>Notes</h2><a href="#/notes/${id}" class="link">${notes?.text ? 'Edit' : 'Add notes'}</a></div>
        ${notes?.text ? `<p class="notes-text">${esc(notes.text)}</p>` : '<p class="muted">No notes yet.</p>'}
        <div class="chips-wrap">${(notes?.parsed?.chips || []).map((c) => `<span class="pchip pchip-${c.kind}">${esc(c.label)}</span>`).join('')}</div>
      </div>
    </div>
    <div class="card coach-takeaway" id="coach-takeaway" hidden></div>
    <div class="actions-row">
      <button class="btn" id="dl-csv">Download CSV</button>
      <button class="btn" id="dl-json">Download JSON</button>
      <span class="spacer"></span>
      <button class="btn danger" id="del-session">Delete</button>
    </div>`;
  const draw = () => drawHrChart($('#session-chart'), {
    points: samples.map((x) => ({ x: x.elapsed_s, y: x.hr })), xMin: 0, xMax: Math.max(session.durationS || 0, samples.at(-1)?.elapsed_s || 60),
    bounds: zoneBpmBounds(s.maxHr, s.zones), laps: (session.laps || []).map((l) => l.elapsed_s),
    gaps: (session.gaps || []).filter((g) => g.startElapsed != null).map((g) => ({ from: g.startElapsed, to: g.endElapsed ?? g.startElapsed })),
    empty: 'No heart-rate samples recorded',
  });
  state.redraw = draw;
  requestAnimationFrame(draw);
  $('#dl-csv').onclick = () => download(`${fileStem(session)}.csv`, samplesToCsv(samples), 'text/csv');
  $('#dl-json').onclick = async () => download(`${fileStem(session)}.json`, JSON.stringify(await sessionBundle(id), null, 2), 'application/json');
  $('#del-session').onclick = async () => {
    if (!confirm('Delete this workout and all its heart-rate data? This can’t be undone.')) return;
    const fresh = await db.get('sessions', id);
    await sync.queueRemoteDelete(id, !!fresh?.syncedAt || sync.syncConfigured());
    await db.deleteSessionLocal(id);
    sync.syncNow();
    toast('Workout deleted');
    go('#/dashboard');
  };
  $('#session-type').onchange = async (e) => {
    session.type = e.target.value || null; session.updatedAt = Date.now();
    await db.put('sessions', session); sync.syncNow(); toast('Type updated');
  };
  $('#open-coach').onclick = () => openCoach({ sessionId: id });
  const sc = $('#send-coach');
  if (sc) sc.onclick = () => { sendWorkoutLog(id); openCoach({ sessionId: id }); };
  renderCoachLogStatus(id);
}

// ------------------------------------------------------------------ coach log status (session detail)
const COACH_CHIP = {
  sent: ['Sent to coach', 'coach-sent'],
  sending: ['Sending to coach…', 'coach-sending'],
  pending: ['Waiting to send to coach', 'coach-pending'],
  failed: ['Coach: not sent', 'coach-failed'],
};

function sendWorkoutLog(id) {
  coachSync.sendNow(id);
  renderCoachLogStatus(id);
}

async function renderCoachLogStatus(id) {
  const box = $('#coach-log-status');
  if (!box) return;
  const s = state.settings;
  const rec = await coachSync.status(id);
  if ($('#coach-log-status') !== box || !location.hash.endsWith(id)) return;
  const takeaway = $('#coach-takeaway');
  if (!coachConfigured(s) && !rec) { box.innerHTML = ''; if (takeaway) takeaway.hidden = true; return; }
  const st = coachSync.inFlight(id) ? 'sending' : rec?.status || null;
  const [label, cls] = COACH_CHIP[st] || ['Not sent to coach', 'coach-none'];
  const title = st === 'failed' && rec?.error ? ` title="${esc(rec.error)}"` : st === 'sent' && rec?.sentAt ? ` title="Sent ${esc(new Date(rec.sentAt).toLocaleString())}"` : '';
  const btn = !coachConfigured(s) || st === 'sending' ? ''
    : `<button type="button" class="btn small ghost" id="coach-send-log">${st === 'sent' ? 'Send again' : 'Send to coach'}</button>`;
  box.innerHTML = `<span class="chip coach-chip ${cls}" data-status="${st || 'none'}"${title}><span class="dot"></span>${label}</span>${btn}`
    + (st === 'failed' && rec?.error ? `<span class="muted small coach-log-error">${esc(rec.error.slice(0, 160))}</span>` : '');
  const b = $('#coach-send-log');
  if (b) b.onclick = () => sendWorkoutLog(id);
  const note = $('#saved-coach-note');
  if (note && st) {
    note.textContent = { sent: 'Your coach has it.', sending: 'Sending it to your coach…', pending: 'It will go to your coach when you’re back online.', failed: 'Couldn’t reach your coach yet. Pulse will retry next time you open it.' }[st] || note.textContent;
  }
  if (takeaway) {
    if (rec?.reply) {
      takeaway.innerHTML = `<div class="card-head"><h2>Coach’s take</h2><button type="button" class="link btn-link" id="takeaway-open">Open chat</button></div><div class="msg-body">${mdLite(rec.reply)}</div>`;
      takeaway.hidden = false;
      $('#takeaway-open').onclick = () => openCoach({ sessionId: id });
    } else takeaway.hidden = true;
  }
}

coachSync.onChange(async (sessionId) => {
  if (document.body.dataset.screen === 'session' && location.hash === `#/session/${sessionId}`) renderCoachLogStatus(sessionId);
  const c = state.coach;
  if (c && c.key === `session:${sessionId}` && !$('#coach').hidden) {
    if (c.abort) return; // a streamed reply is in progress; its finish merges and re-renders
    c.chat = (await db.get('chats', c.key)) || c.chat;
    if (state.coach === c) renderCoachMessages();
  }
});

// ------------------------------------------------------------------ dashboard
async function computeTrends(range = state.range) {
  const sessions = (await db.listSessions()).filter((s) => s.status === 'complete');
  const notes = await db.notesMap();
  const trends = buildTrends(sessions, notes, range);
  trends.patterns = computePatterns(sessions, notes);
  return { trends, sessions, notes };
}

async function renderDashboard() {
  const seq = state.routeSeq;
  showScreen('dashboard');
  const { trends, sessions, notes } = await computeTrends();
  if (isStale(seq)) return;
  const el = $('#screen-dashboard');
  const rows = sessions.filter((x) => x.startedAt >= trends.since).slice(0, 60);
  el.innerHTML = `
    <div class="page-head">
      <div><div class="eyebrow">Dashboard</div><h1>Your training</h1></div>
      <div class="head-actions">
        <div class="seg" role="tablist">${['4w', '3m', '1y'].map((r) => `<button role="tab" data-range="${r}" class="${state.range === r ? 'on' : ''}" aria-selected="${state.range === r}">${{ '4w': '4 weeks', '3m': '3 months', '1y': '1 year' }[r]}</button>`).join('')}</div>
        <button class="btn" id="dash-coach">Ask coach</button>
      </div>
    </div>
    <div class="tiles">
      <div class="tile"><span class="tile-label">Workouts this week</span><span class="tile-value">${trends.workoutsThisWeek}</span></div>
      <div class="tile"><span class="tile-label">Total time</span><span class="tile-value">${fmtDuration(trends.totalS, { long: true })}</span><span class="tile-unit">${trends.count} sessions</span></div>
      <div class="tile"><span class="tile-label">Avg session HR</span><span class="tile-value">${trends.avgSessionHr ?? '–'}</span><span class="tile-unit">bpm</span></div>
    </div>
    ${sessions.length ? '' : `<div class="card empty"><p>No workouts yet. Finish one and it shows up here.</p><p class="muted">Exploring? Turn on Demo in Settings and add demo history.</p></div>`}
    <div class="grid-2">
      <div class="card"><h2>Weekly minutes</h2><canvas id="ch-weekly" class="chart"></canvas></div>
      <div class="card"><h2>Average HR per session</h2><canvas id="ch-avg" class="chart"></canvas></div>
      <div class="card"><h2>Weekly time in zones <span class="muted small">(min)</span></h2><canvas id="ch-zones" class="chart"></canvas>
        <div class="legend">${ZONE_NAMES.map((n, i) => `<span><span class="sw" style="background:${zoneVar(i + 1)}"></span>Z${i + 1}</span>`).join('')}</div></div>
      <div class="card"><h2>Effort vs average HR</h2><canvas id="ch-effort" class="chart"></canvas></div>
    </div>
    <div class="card patterns">
      <h2>Patterns</h2>
      ${trends.patterns.length ? `<ul>${trends.patterns.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p class="muted">A few more workouts with notes (sleep, effort, aches) and Pulse will start spotting patterns.</p>'}
    </div>
    <div class="card">
      <h2>Sessions</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>Type</th><th>Duration</th><th>Avg</th><th>Max</th><th>Effort</th><th class="hide-sm">Notes</th></tr></thead>
        <tbody>${rows.map((x) => {
          const n = notes.get(x.id);
          return `<tr data-href="#/session/${x.id}" tabindex="0"><td>${esc(fmtDate(x.startedAt, { month: 'short', day: 'numeric' }))}</td><td>${esc(x.type || '–')}</td><td>${fmtDuration(x.durationS)}</td><td>${x.summary?.avg ?? '–'}</td><td>${x.summary?.max ?? '–'}</td><td>${n?.parsed?.effort ?? '–'}</td><td class="hide-sm muted ellipsis">${esc((n?.text || '').slice(0, 80))}</td></tr>`;
        }).join('') || '<tr><td colspan="7" class="muted">No sessions in this range.</td></tr>'}</tbody>
      </table></div>
    </div>`;
  const colors = zoneColors();
  const wkLabel = (w) => fmtDate(w.start, { month: 'short', day: 'numeric' });
  const draw = () => {
    drawBars($('#ch-weekly'), { labels: trends.weeks.map(wkLabel), series: [{ values: trends.weeks.map((w) => Math.round(w.minutes)), color: cssVar('--accent') }] });
    drawLine($('#ch-avg'), { points: trends.perSession.map((p, i) => ({ x: i, y: p.avg, t: p.t })), label: (p) => fmtDate(p.t, { month: 'short', day: 'numeric' }), color: cssVar('--z4'), empty: 'No sessions yet' });
    drawBars($('#ch-zones'), { labels: trends.weeks.map(wkLabel), stacked: true, series: colors.map((c, i) => ({ values: trends.weeks.map((w) => Math.round(w.zones[i])), color: c })) });
    drawScatter($('#ch-effort'), {
      points: trends.effortPoints.map((p) => ({ x: p.effort, y: p.avg, color: colors[zoneFor(p.avg, state.settings.maxHr, state.settings.zones) - 1] })),
      xMin: 0, xMax: 10, xLabel: 'Effort (from notes, /10)', empty: 'Say “effort 7 out of 10” in your notes to see this',
    });
  };
  state.redraw = draw;
  requestAnimationFrame(draw);
  $$('.seg button', el).forEach((b) => { b.onclick = () => { state.range = b.dataset.range; renderDashboard(); }; });
  $$('tr[data-href]', el).forEach((tr) => {
    tr.onclick = () => go(tr.dataset.href);
    tr.onkeydown = (e) => { if (e.key === 'Enter') go(tr.dataset.href); };
  });
  $('#dash-coach').onclick = () => openCoach({ sessionId: null });
}

// ------------------------------------------------------------------ settings
async function renderSettings() {
  showScreen('settings');
  const s = state.settings;
  const bounds = zoneBpmBounds(s.maxHr, s.zones);
  const seq = state.routeSeq;
  const user = sync.syncConfigured() ? await sync.currentUser().catch(() => null) : null;
  if (isStale(seq)) return;
  const el = $('#screen-settings');
  el.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Settings</div><h1>Settings</h1></div></div>
    <form id="settings-form" class="settings" autocomplete="off" onsubmit="return false">
      <section class="card">
        <h2>Heart-rate zones</h2>
        <div class="field-row">
          <label class="field"><span>Max heart rate</span><input type="number" name="maxHr" min="120" max="230" value="${s.maxHr}" inputmode="numeric"></label>
        </div>
        <div class="zones-edit">
          ${[0, 1, 2, 3].map((i) => `<label class="field"><span><span class="sw" style="background:${zoneVar(i + 2)}"></span>Z${i + 2} starts at (% max)</span><input type="number" name="zone${i}" min="30" max="100" value="${s.zones[i]}" inputmode="numeric"><small class="muted">${bounds[i]} bpm</small></label>`).join('')}
        </div>
        <p class="muted small">Z1 is everything below Z2. Defaults: Z1 &lt;60%, Z2 60–70%, Z3 70–80%, Z4 80–90%, Z5 &gt;90%.</p>
      </section>
      <section class="card">
        <h2>Calorie estimate</h2>
        <div class="field-row">
          <label class="field"><span>Weight</span><input type="number" name="weight" min="60" max="700" step="0.1" value="${s.weight}" inputmode="decimal"></label>
          <label class="field"><span>Unit</span><select name="weightUnit"><option value="lb"${s.weightUnit === 'lb' ? ' selected' : ''}>lb</option><option value="kg"${s.weightUnit === 'kg' ? ' selected' : ''}>kg</option></select></label>
          <label class="field"><span>Age</span><input type="number" name="age" min="10" max="100" value="${s.age}" inputmode="numeric"></label>
          <label class="field"><span>Formula</span><select name="sex"><option value="male"${s.sex === 'male' ? ' selected' : ''}>Male</option><option value="female"${s.sex === 'female' ? ' selected' : ''}>Female</option></select></label>
        </div>
        <p class="muted small">Heart-rate based estimate (Keytel et al., 2005). Treat it as a rough guide.</p>
      </section>
      <section class="card">
        <h2>Display</h2>
        <div class="field-row">
          <label class="field"><span>Layout</span><select name="layout">${['auto', 'phone', 'desk'].map((v) => `<option value="${v}"${s.layout === v ? ' selected' : ''}>${{ auto: 'Automatic (by screen width)', phone: 'Phone', desk: 'Desk (big screen)' }[v]}</option>`).join('')}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="demo"${s.demo ? ' checked' : ''}> Demo mode (simulated strap, no Bluetooth needed)</label>
        <div class="btn-row"><button type="button" class="btn small" id="demo-history">Add demo history</button><button type="button" class="btn small ghost" id="demo-clear">Remove demo history</button></div>
      </section>
      <section class="card">
        <h2>Sync (Supabase, optional)</h2>
        <p class="muted small">Workouts always save on this device first. Add your Supabase project to back them up and see them on every device.</p>
        <label class="field"><span>Project URL</span><input type="url" name="supabaseUrl" placeholder="https://xxxx.supabase.co" value="${esc(s.supabaseUrl)}"></label>
        <label class="field"><span>Anon (public) key</span><input type="text" name="supabaseAnonKey" placeholder="eyJ…" value="${esc(s.supabaseAnonKey)}" spellcheck="false"></label>
        <div id="auth-box">
          ${user ? `<p>Signed in as <strong>${esc(user.email)}</strong></p>
            <div class="btn-row"><button type="button" class="btn small primary" id="sync-now">Sync now</button><button type="button" class="btn small ghost" id="sign-out">Sign out</button></div>`
            : `<div class="field-row"><label class="field grow"><span>Email</span><input type="email" id="auth-email" placeholder="you@example.com" value="${esc(localStorage.getItem('pulse.authEmail') || '')}"></label></div>
            <div class="btn-row"><button type="button" class="btn small primary" id="send-link">Email me a sign-in link</button></div>
            <div class="field-row"><label class="field"><span>Or enter the 6-digit code</span><input type="text" id="auth-code" inputmode="numeric" maxlength="10" placeholder="123456"></label><button type="button" class="btn small" id="verify-code">Verify</button></div>
            <p class="muted small">On iPhone the email link opens Safari, not Bluefy, so use the code (see README to add it to the email).</p>`}
        </div>
        <p class="muted small" id="sync-detail"></p>
      </section>
      <section class="card">
        <h2>Coach (OpenClaw)</h2>
        <label class="field"><span>Gateway URL</span><input type="url" name="gatewayUrl" placeholder="https://your-mac.tailnet-name.ts.net:8443" value="${esc(s.gatewayUrl)}"></label>
        <label class="field"><span>Gateway token</span><div class="inline"><input type="password" name="gatewayToken" value="${esc(s.gatewayToken)}" spellcheck="false" autocomplete="off"><button type="button" class="btn small ghost" id="show-token">Show</button></div></label>
        <label class="field"><span>Agent (model)</span><input type="text" name="coachModel" value="${esc(s.coachModel)}" spellcheck="false"></label>
        <label class="field"><span>Coach session key</span><input type="text" name="coachSessionKey" placeholder="e.g. your Telegram coach thread’s session key" value="${esc(s.coachSessionKey)}" spellcheck="false" autocomplete="off" autocapitalize="off"></label>
        <p class="muted small" id="session-key-hint">${esc(sessionKeyIssue(s.coachSessionKey) || 'Optional. Sent as x-openclaw-session-key so every coach message lands in that one OpenClaw session (find it with openclaw sessions). Leave empty for stateless chats, or set OPENCLAW_SESSION_KEY on the proxy instead.')}</p>
        <label class="check"><input type="checkbox" name="coachAutoSend" id="coach-autosend"${(typeof s.coachAutoSend === 'boolean' ? s.coachAutoSend : !!coachSessionKey(s)) ? ' checked' : ''}> Send each workout to coach automatically</label>
        <div class="btn-row"><button type="button" class="btn small" id="test-coach">Test connection</button></div>
        <p class="muted small" id="coach-test-result">The token stays in this browser only (localStorage). It never goes into the repo or to Supabase.</p>
      </section>
      <section class="card">
        <h2>Your data</h2>
        <div class="btn-row">
          <button type="button" class="btn small" id="export-all">Export all (JSON)</button>
          <label class="btn small"><input type="file" id="import-file" accept="application/json,.json" hidden>Import…</label>
        </div>
        <p class="muted small">Export includes every session, sample and note (no tokens). Import merges a Pulse export into this device.</p>
      </section>
    </form>`;

  const form = $('#settings-form');
  form.addEventListener('input', debounce(() => onSettingsInput(form), 300));
  form.addEventListener('change', () => onSettingsInput(form));
  $('#show-token').onclick = () => {
    const i = form.elements.gatewayToken; i.type = i.type === 'password' ? 'text' : 'password';
    $('#show-token').textContent = i.type === 'password' ? 'Show' : 'Hide';
  };
  $('#demo-history').onclick = async () => {
    toast('Adding demo history…');
    const n = await generateDemoHistory(state.settings);
    toast(`Added ${n} demo workouts`);
  };
  $('#demo-clear').onclick = async () => { const n = await removeDemoHistory(); toast(`Removed ${n} demo workouts`); };
  $('#test-coach').onclick = testCoach;
  $('#coach-autosend').addEventListener('change', (e) => {
    e.stopPropagation();
    state.settings = saveSettings({ coachAutoSend: e.target.checked });
  });
  $('#export-all').onclick = async () => {
    const data = await exportAll();
    download(`pulse-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  };
  $('#import-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await importData(await f.text());
      state.settings = getSettings();
      toast(`Imported ${r.sessions} sessions, ${r.samples} samples`);
      sync.syncNow();
    } catch (err) { toast(`Import failed: ${err.message}`, 4000); }
    e.target.value = '';
  };
  const sendLink = $('#send-link');
  if (sendLink) {
    sendLink.onclick = async () => {
      const email = $('#auth-email').value.trim();
      if (!email) return toast('Enter your email');
      localStorage.setItem('pulse.authEmail', email);
      try { await sync.sendMagicLink(email); toast('Check your email for the link or code', 4000); } catch (err) { toast(err.message, 4500); }
    };
    $('#verify-code').onclick = async () => {
      const email = $('#auth-email').value.trim();
      try { await sync.verifyCode(email, $('#auth-code').value); toast('Signed in'); renderSettings(); } catch (err) { toast(err.message, 4500); }
    };
  }
  const so = $('#sign-out'); if (so) so.onclick = async () => { await sync.signOut(); renderSettings(); };
  const sn = $('#sync-now'); if (sn) sn.onclick = () => sync.syncNow();
  const st = sync.syncStatus();
  $('#sync-detail').textContent = st.state === 'off' ? '' : st.message;
}

function onSettingsInput(form) {
  const f = form.elements;
  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const zones = [0, 1, 2, 3].map((i) => num(f[`zone${i}`].value, state.settings.zones[i]));
  const sorted = zones.every((z, i) => i === 0 || z > zones[i - 1]);
  const before = state.settings;
  state.settings = saveSettings({
    maxHr: Math.round(num(f.maxHr.value, 190)),
    zones: sorted ? zones : before.zones,
    weight: num(f.weight.value, before.weight), weightUnit: f.weightUnit.value,
    age: Math.round(num(f.age.value, before.age)), sex: f.sex.value,
    layout: f.layout.value, demo: f.demo.checked,
    supabaseUrl: f.supabaseUrl.value.trim(), supabaseAnonKey: f.supabaseAnonKey.value.trim(),
    gatewayUrl: f.gatewayUrl.value.trim(), gatewayToken: f.gatewayToken.value.trim(),
    coachModel: f.coachModel.value.trim() || 'openclaw/default',
    coachSessionKey: f.coachSessionKey.value.trim(),
  });
  if (!sorted) toast('Zone starts must increase from Z2 to Z5');
  state.recorder.settings = state.settings;
  applyLayout();
  // Session key: show problems; the auto-send box follows the key until the user ticks it themselves.
  const hint = $('#session-key-hint');
  if (hint) {
    const issue = sessionKeyIssue(state.settings.coachSessionKey);
    hint.classList.toggle('warn-text', !!issue);
    if (issue) hint.textContent = issue;
  }
  if (typeof state.settings.coachAutoSend !== 'boolean' && f.coachAutoSend) f.coachAutoSend.checked = !!coachSessionKey(state.settings);
  if (before.gatewayUrl !== state.settings.gatewayUrl || before.gatewayToken !== state.settings.gatewayToken) coachSync.retryAll();
  // live-update the bpm hints
  const b = zoneBpmBounds(state.settings.maxHr, state.settings.zones);
  $$('.zones-edit small').forEach((sm, i) => { sm.textContent = `${b[i]} bpm`; });
  if (before.supabaseUrl !== state.settings.supabaseUrl || before.supabaseAnonKey !== state.settings.supabaseAnonKey) {
    if (sync.syncConfigured()) setTimeout(renderSettings, 50);
  }
}

async function testCoach() {
  const out = $('#coach-test-result');
  const s = state.settings;
  if (!coachConfigured(s)) { out.textContent = 'Enter the gateway URL and token first.'; return; }
  out.textContent = 'Testing…';
  const base = s.gatewayUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  try {
    const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${s.gatewayToken}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (token rejected)' : res.status === 404 ? ' (enable gateway.http.endpoints.chatCompletions)' : ''}`);
    const j = await res.json();
    const ids = (j.data || []).map((m) => m.id);
    out.textContent = `Connected. Agents: ${ids.slice(0, 6).join(', ') || '(none listed)'}`;
  } catch (e) {
    out.textContent = `Couldn’t reach the gateway: ${e.message}. If this is “Failed to fetch”, it’s usually Tailscale being off or CORS (run tools/coach-proxy.mjs — see README).`;
  }
}

// ------------------------------------------------------------------ coach panel
async function openCoach({ sessionId = null, autoSend = false } = {}) {
  const panel = $('#coach');
  const key = sessionId ? `session:${sessionId}` : 'dashboard';
  const chat = (await db.get('chats', key)) || { key, messages: [] };
  let sessionText = '';
  let title = 'Training overview';
  if (sessionId) {
    const [session, notes, samples] = await Promise.all([db.get('sessions', sessionId), db.get('notes', sessionId), db.getSamples(sessionId)]);
    sessionText = sessionContext(session, notes, samples, state.settings);
    title = `${fmtDate(session.startedAt)} · ${session.type || 'Workout'}`;
  }
  const { trends } = await computeTrends('4w');
  const trendText = trendContext(trends);
  state.coach = { key, chat, sessionText, trendText, abort: null };
  $('#coach-title').textContent = title;
  $('#coach-context').textContent = [sessionText, trendText].filter(Boolean).join('\n\n');
  panel.hidden = false;
  document.body.classList.add('coach-open');
  renderCoachMessages();
  const configured = coachConfigured(state.settings);
  $('#coach-setup').hidden = configured;
  $('#coach-form').hidden = !configured;
  if (configured && autoSend && !chat.messages.length && !(sessionId && coachSync.inFlight(sessionId))) {
    sendCoachMessage('I just finished this workout (details in the context). Please log it and give me feedback: what went well, what to watch, and what to do next session.');
  } else if (configured) {
    setTimeout(() => $('#coach-input').focus(), 50);
  }
}

function closeCoach() {
  state.coach?.abort?.abort();
  $('#coach').hidden = true;
  document.body.classList.remove('coach-open');
}

function mdLite(text) {
  // Escape first, then a tiny safe subset: **bold**, `code`, bullet lines, paragraphs.
  let h = esc(text);
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = h.split('\n');
  let out = ''; let inList = false;
  for (const line of lines) {
    const m = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (m) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${m[1]}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    if (/^#{1,4}\s/.test(line)) out += `<p><strong>${line.replace(/^#{1,4}\s/, '')}</strong></p>`;
    else if (line.trim()) out += `<p>${line}</p>`;
  }
  if (inList) out += '</ul>';
  return out;
}

function renderCoachMessages(streamingText = null) {
  const box = $('#coach-messages');
  const msgs = state.coach.chat.messages;
  const logSid = state.coach.key.startsWith('session:') ? state.coach.key.slice(8) : null;
  if (streamingText == null && logSid && coachSync.inFlight(logSid)) streamingText = '';
  box.innerHTML = (msgs.length || streamingText != null ? '' : '<p class="muted">Ask about this workout, your week, or what to do next. Your coach sees the summary above.</p>')
    + msgs.map((m) => (m.kind === 'workout-log'
      ? `<div class="msg user log"><details><summary>Workout log sent to coach</summary><div>${esc(m.content).replace(/\n/g, '<br>')}</div></details></div>`
      : `<div class="msg ${m.role}${m.error ? ' error' : ''}">${m.role === 'assistant' ? mdLite(m.content) : esc(m.content).replace(/\n/g, '<br>')}</div>`)).join('')
    + (streamingText != null ? `<div class="msg assistant streaming">${streamingText ? mdLite(streamingText) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>` : '');
  box.scrollTop = box.scrollHeight;
}

async function sendCoachMessage(text) {
  const c = state.coach;
  if (!c || !text.trim() || c.abort) return;
  c.chat.messages.push({ role: 'user', content: text.trim(), at: Date.now() });
  await db.put('chats', c.chat);
  renderCoachMessages('');
  const ac = new AbortController();
  c.abort = ac;
  $('#coach-send').textContent = 'Stop';
  const history = c.chat.messages.filter((m) => !m.error);
  const messages = buildMessages({ sessionText: c.sessionText, trendText: c.trendText, history });
  try {
    let last = 0;
    const full = await sendChat(state.settings, messages, (delta, so) => {
      const now = performance.now();
      if (now - last > 60) { last = now; renderCoachMessages(so); }
    }, ac.signal);
    c.chat.messages.push({ role: 'assistant', content: full || '(empty reply)', at: Date.now() });
  } catch (e) {
    if (e.name !== 'AbortError') c.chat.messages.push({ role: 'assistant', content: e.message, error: true, at: Date.now() });
  } finally {
    c.abort = null;
    $('#coach-send').textContent = 'Send';
    c.chat = await mergeChat(c.chat);
    await db.put('chats', c.chat);
    if (state.coach === c) renderCoachMessages();
  }
}

/** Merge messages another writer (the workout-log sender) stored meanwhile. */
async function mergeChat(chat) {
  const stored = await db.get('chats', chat.key);
  if (!stored?.messages?.length) return chat;
  const sig = (m) => `${m.role}|${m.at}|${m.kind || ''}`;
  const have = new Set(chat.messages.map(sig));
  const extra = stored.messages.filter((m) => !have.has(sig(m)) && (m.kind === 'workout-log' || m.kind === 'workout-log-reply'));
  if (!extra.length) return chat;
  return { ...chat, messages: [...chat.messages, ...extra].sort((a, b) => (a.at || 0) - (b.at || 0)) };
}

// ------------------------------------------------------------------ sync chip
function renderSyncChip(st) {
  const chip = $('#sync-chip');
  if (!chip) return;
  chip.hidden = st.state === 'off';
  chip.textContent = { ok: 'Synced', syncing: 'Syncing…', offline: 'Offline', error: 'Sync error', 'signed-out': 'Not signed in' }[st.state] || st.message;
  chip.title = st.message || '';
  chip.className = `chip chip-quiet sync-${st.state}`;
  const d = $('#sync-detail'); if (d) d.textContent = st.message;
}

// ------------------------------------------------------------------ boot
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function bindStatic() {
  $('#start-btn').addEventListener('click', () => handleStart());
  $('#type-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    state.selectedType = state.selectedType === b.dataset.type ? null : b.dataset.type;
    if (state.selectedType) localStorage.setItem('pulse.lastType', state.selectedType); else localStorage.removeItem('pulse.lastType');
    $$('#type-chips [data-type]').forEach((x) => { const on = x.dataset.type === state.selectedType; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
  });
  $('#demo-toggle').addEventListener('change', (e) => {
    state.settings = saveSettings({ demo: e.target.checked });
    renderStart();
  });
  $('#pick-btn').addEventListener('click', () => {
    const strap = state.strap instanceof BleStrap ? state.strap : new BleStrap();
    if (strap !== state.strap) bindStrap(strap);
    $('#connect-problem').hidden = true; $('#pick-btn').hidden = true;
    strap.connectWithPicker().catch((e) => connectingProblem(e?.name === 'NotFoundError' ? 'No strap chosen.' : `Couldn’t connect: ${e.message}`));
  });
  $('#connect-demo').addEventListener('click', () => {
    state.settings = saveSettings({ demo: true });
    const resumeSession = state.connecting?.resumeSession || null;
    state.connecting = null;
    handleStart({ resumeSession });
  });
  $('#connect-cancel').addEventListener('click', cancelConnecting);
  $('#lap-btn').addEventListener('click', () => { const n = state.recorder.lap(); if (n) toast(`Lap ${n}`, 1200); });
  $('#pause-btn').addEventListener('click', () => {
    if (state.recorder.paused) state.recorder.resumeFromPause(); else state.recorder.pause();
    renderLiveValues();
  });
  $('#end-btn').addEventListener('click', handleEnd);
  $('#demo-dropout').addEventListener('click', () => { state.strap?.simulateDropout?.(6); });
  $('#notes-text').addEventListener('input', debounce(updateParsed, 200));
  $('#mic-btn').addEventListener('click', toggleDictation);
  $('#save-notes').addEventListener('click', saveNotes);
  $('#skip-notes').addEventListener('click', async () => {
    const id = $('#notes-text').dataset.sessionId;
    state.justSaved = id;
    await afterWorkoutSaved(id);
    go(`#/session/${id}`);
  });
  $('#layout-toggle').addEventListener('click', () => {
    const desk = document.body.classList.contains('desk');
    state.settings = saveSettings({ layout: desk ? 'phone' : 'desk' });
    applyLayout();
    state.redraw?.();
  });
  $('#coach-close').addEventListener('click', closeCoach);
  $('#coach-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.coach?.abort) { state.coach.abort.abort(); return; }
    const input = $('#coach-input');
    const v = input.value; input.value = '';
    sendCoachMessage(v);
  });
  $('#coach-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#coach-form').requestSubmit(); }
  });
  $('#coach-clear').addEventListener('click', async () => {
    if (!state.coach) return;
    state.coach.chat.messages = [];
    await db.put('chats', state.coach.chat);
    renderCoachMessages();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', debounce(() => { applyLayout(); state.redraw?.(); }, 120));
  window.addEventListener('pagehide', () => { if (state.recorder.active) state.recorder.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.recorder.active) state.recorder.flush(); });
  window.addEventListener('beforeunload', (e) => { if (state.recorder.active) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#coach').hidden) closeCoach();
    if (document.body.dataset.screen === 'live' && !e.target.closest('input,textarea')) {
      if (e.key === 'l' || e.key === 'L') $('#lap-btn').click();
      if (e.key === ' ') { e.preventDefault(); $('#pause-btn').click(); }
    }
  });
}

async function boot() {
  applyLayout();
  bindStatic();
  sync.onSyncStatus(renderSyncChip);
  try { await db.openDb(); } catch (e) { toast(`Storage unavailable: ${e.message}`, 6000); }
  // Supabase magic-link redirects land with #access_token=...; let supabase-js consume it first.
  if (sync.syncConfigured()) {
    try { const c = await sync.getClient(); await c?.auth.getSession(); } catch (e) { console.warn('Supabase unavailable', e); }
  }
  if (!location.hash.startsWith('#/')) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  sync.startAutoSync();
  route();
  // Workout logs that failed or never left (offline, coach down, app closed mid-send).
  if (coachConfigured(state.settings)) setTimeout(() => coachSync.retryAll(), 1500);
  window.addEventListener('online', () => coachSync.retryAll());
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.info('SW registration failed', e?.message));
  }
}

window.__pulse = { state, db, coachSync };
boot();
