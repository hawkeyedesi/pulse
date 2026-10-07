// Settings live only in this device's localStorage (including the coach token).
import { DEFAULT_SETTINGS } from './stats.js';

const KEY = 'pulse.settings';
let cache = null;
const listeners = new Set();

export function getSettings() {
  if (!cache) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
    cache = { ...DEFAULT_SETTINGS, ...saved };
    if (!Array.isArray(cache.zones) || cache.zones.length !== 4) cache.zones = [...DEFAULT_SETTINGS.zones];
  }
  return cache;
}

export function saveSettings(patch) {
  cache = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(cache));
  listeners.forEach((fn) => fn(cache));
  return cache;
}

export function onSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Settings safe to include in an export file (no secrets). */
export function exportableSettings() {
  const { gatewayToken, supabaseAnonKey, coachSessionKey, ...rest } = getSettings();
  return rest;
}
