#!/usr/bin/env node
// Pulse coach CORS proxy — run on the Mac that runs OpenClaw.
//
// Why: the OpenClaw Gateway's /v1/chat/completions endpoint does not send CORS headers
// and answers the browser's OPTIONS preflight with 405, so a page served from
// https://<you>.github.io cannot call it directly. This ~80-line proxy (Node 18+, no
// dependencies) answers the preflight for your Pulse origin only and forwards
// everything else, unchanged and streamed, to the local Gateway.
//
// Usage:
//   PULSE_ORIGIN=https://<you>.github.io node coach-proxy.mjs
//   tailscale serve --bg --https=8443 http://127.0.0.1:18790
//   -> in Pulse Settings, Gateway URL = https://<mac-name>.<tailnet>.ts.net:8443
//
// Env:
//   PULSE_ORIGIN   comma-separated allowed browser origins (required), e.g.
//                  "https://you.github.io,http://localhost:8000"
//   GATEWAY_URL    upstream Gateway (default http://127.0.0.1:18789)
//   PORT           listen port (default 18790); always binds 127.0.0.1
//   OPENCLAW_SESSION_KEY  optional default x-openclaw-session-key for /v1/chat/completions
//                  when the browser sends none (e.g. your Telegram coach thread's key).
//                  A key sent by Pulse (Settings -> Coach session key) always wins.
//
// The gateway token is NOT stored here: Pulse sends it as Authorization: Bearer and the
// proxy passes it through untouched, so the proxy grants nothing on its own.

import http from 'node:http';

const ORIGINS = (process.env.PULSE_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const UPSTREAM = new URL(process.env.GATEWAY_URL || 'http://127.0.0.1:18789');
const PORT = Number(process.env.PORT || 18790);
const ALLOWED_PATHS = /^\/v1\/(chat\/completions|models(\/.*)?)$/;
const SESSION_HEADER = 'x-openclaw-session-key';
const DEFAULT_SESSION_KEY = (process.env.OPENCLAW_SESSION_KEY || '').trim();
const RESERVED = /^(subagent|cron|acp):/i;

if (!ORIGINS.length) {
  console.error('Set PULSE_ORIGIN, e.g. PULSE_ORIGIN=https://yourname.github.io');
  process.exit(1);
}
if (DEFAULT_SESSION_KEY && RESERVED.test(DEFAULT_SESSION_KEY)) {
  console.error('OPENCLAW_SESSION_KEY uses a reserved namespace (subagent:, cron:, acp:); the gateway would reject it.');
  process.exit(1);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, x-openclaw-agent-id, x-openclaw-model, x-openclaw-session-key');
    res.setHeader('Access-Control-Max-Age', '600');
    // Chrome Private/Local Network Access: a public page (github.io) calling a Tailscale
    // 100.x address may send this preflight header; opt in explicitly.
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    return true;
  }
  return !origin; // non-browser callers (curl) have no Origin header
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const allowed = cors(req, res);
  if (!allowed) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Origin not allowed'); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (!ALLOWED_PATHS.test(path)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }

  const headers = { ...req.headers, host: UPSTREAM.host };
  delete headers.origin; delete headers.referer;
  // Do not forward Tailscale/forwarding headers: the Gateway must see a plain loopback caller
  // authenticated by the bearer token.
  for (const h of Object.keys(headers)) if (/^(x-forwarded-|tailscale-|forwarded$|x-real-ip$)/i.test(h)) delete headers[h];
  // Session routing: forward the browser's x-openclaw-session-key as-is (Node lower-cases
  // header names, so it is already in `headers`); fall back to OPENCLAW_SESSION_KEY.
  const sent = String(headers[SESSION_HEADER] || '').trim();
  if (sent) headers[SESSION_HEADER] = sent;
  else delete headers[SESSION_HEADER];
  if (!sent && DEFAULT_SESSION_KEY && path === '/v1/chat/completions') headers[SESSION_HEADER] = DEFAULT_SESSION_KEY;

  const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, path: req.url, method: req.method, headers }, (ur) => {
    const h = { ...ur.headers };
    delete h['access-control-allow-origin'];
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res); // streams SSE chunks as they arrive
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Gateway unreachable at ${UPSTREAM.href}: ${e.message}` } }));
  });
  res.on('close', () => up.destroy()); // client went away -> cancel the agent run
  req.pipe(up);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Pulse coach proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM.href}`);
  console.log(`Allowed origins: ${ORIGINS.join(', ')}`);
  if (DEFAULT_SESSION_KEY) console.log('Default coach session key: set (OPENCLAW_SESSION_KEY)');
});
