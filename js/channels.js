// Coach channels: several OpenClaw sessions (e.g. the Telegram workout topic and a food topic),
// each with the kinds of logs routed to it. Pure functions (Node-testable).
//
//   settings.coachChannels = [{ id, name, sessionKey, routes: ['workouts' | 'food' | 'weighins'] }]
//
// Backward compatible: the legacy single `coachSessionKey` migrates into a "Workouts" channel,
// and `coachSessionKey` keeps mirroring the workouts channel's key so the existing workout
// sender / chat code (which reads settings.coachSessionKey) keeps working unchanged.

export const ROUTES = ['workouts', 'food', 'weighins'];
export const ROUTE_LABELS = { workouts: 'Workouts', food: 'Food logs', weighins: 'Weigh-ins' };

const clean = (s) => String(s ?? '').trim();
const slug = (s, i) => (clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `channel-${i + 1}`);

export function normalizeChannels(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((c, i) => {
    let id = clean(c?.id) || slug(c?.name, i);
    while (seen.has(id)) id += '-2';
    seen.add(id);
    return {
      id,
      name: clean(c?.name) || `Channel ${i + 1}`,
      sessionKey: clean(c?.sessionKey),
      routes: ROUTES.filter((r) => (c?.routes || []).includes(r)),
    };
  });
}

/**
 * Settings patch that migrates a pre-channels settings object. Returns null when nothing to do.
 * Existing key -> "Workouts" channel routed to workouts. A "Food" channel with no key is added
 * for food logs and weigh-ins so the user only has to paste its key.
 */
export function migrateChannels(settings) {
  if (Array.isArray(settings?.coachChannels)) return null;
  const key = clean(settings?.coachSessionKey);
  return {
    coachChannels: [
      { id: 'workouts', name: 'Workouts', sessionKey: key, routes: ['workouts'] },
      { id: 'food', name: 'Food', sessionKey: '', routes: ['food', 'weighins'] },
    ],
  };
}

/** First channel that takes this route (or null). */
export function channelFor(settings, route) {
  return normalizeChannels(settings?.coachChannels).find((c) => c.routes.includes(route)) || null;
}

/**
 * Settings to use when talking to the coach for a route: same gateway, the channel's session key.
 * Workouts fall back to the legacy coachSessionKey when no channel is routed (old settings).
 * Food / weigh-ins need a channel WITH a session key: they must never land in the workout
 * thread by accident, so this returns null until the food channel's key is set.
 */
export function settingsForRoute(settings, route) {
  const ch = channelFor(settings, route);
  if (route === 'workouts') {
    if (!ch) return settings;
    return { ...settings, coachSessionKey: ch.sessionKey };
  }
  if (!ch || !ch.sessionKey) return null;
  return { ...settings, coachSessionKey: ch.sessionKey };
}

/** Keep the legacy coachSessionKey in step with the workouts channel. */
export function syncLegacyKey(channels) {
  const ws = normalizeChannels(channels).find((c) => c.routes.includes('workouts'));
  return ws ? ws.sessionKey : '';
}
