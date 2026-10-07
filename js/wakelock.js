// Keep the screen awake during a workout.
// Uses the Screen Wake Lock API (Chrome/Edge, iOS 16.4+ WebKit) and Bluefy's
// bluetooth.setScreenDimEnabled(false) when present.

let sentinel = null;
let wanted = false;
let listenersBound = false;
const subs = new Set();

function bluefyDim(enabled) {
  const candidates = [navigator.bluetooth, window.bluetooth];
  for (const bt of candidates) {
    if (bt && typeof bt.setScreenDimEnabled === 'function') {
      try { bt.setScreenDimEnabled(enabled); return true; } catch (e) { console.info('setScreenDimEnabled failed', e); }
    }
  }
  return false;
}

export function wakeState() {
  return { wanted, wakeLock: !!sentinel && !sentinel.released, bluefy: bluefyAvailable() };
}
function bluefyAvailable() {
  return [navigator.bluetooth, window.bluetooth].some((bt) => bt && typeof bt.setScreenDimEnabled === 'function');
}
function notify() { const s = wakeState(); subs.forEach((fn) => fn(s)); }
export function onWakeChange(fn) { subs.add(fn); return () => subs.delete(fn); }

async function acquire() {
  if (!wanted || document.visibilityState !== 'visible') return;
  if ('wakeLock' in navigator && (!sentinel || sentinel.released)) {
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', notify);
    } catch (e) {
      console.info('Wake lock unavailable:', e?.message);
    }
  }
  notify();
}

export async function keepAwake() {
  wanted = true;
  bluefyDim(false);
  if (!listenersBound) {
    listenersBound = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquire(); });
    window.addEventListener('focus', () => acquire());
  }
  await acquire();
}

export async function allowSleep() {
  wanted = false;
  bluefyDim(true);
  try { await sentinel?.release(); } catch { /* ignore */ }
  sentinel = null;
  notify();
}
