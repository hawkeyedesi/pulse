# Pulse — heart-rate workout tracker

Pulse is a personal workout tracker for a Polar chest strap (H10 or H9, or any strap that exposes the standard Bluetooth Heart Rate Service). It runs entirely in the browser:

- **iPhone:** inside the free **Bluefy** browser (it has Web Bluetooth; Safari doesn't).
- **Desk:** Chrome or Edge on a computer, with a big-screen "desk" layout readable from about 6 ft.

You tap **Start workout**, Pulse connects to the strap, and it shows your live BPM, zone, timer, a 5-minute chart, averages and calories, time in zones, battery, and Lap/Set, Pause and End buttons. Afterwards you dictate notes, which a local parser turns into chips ("Bench press 4×8 @155 lb", "Effort 7/10", "Sleep ~6 h", "Shoulder tightness"). Every session gets a detail page with a full chart and CSV/JSON export, and there's a trends dashboard plus a chat panel with your **OpenClaw** coach.

It's a static site with no build step (plain HTML, CSS and ES modules), so GitHub Pages can host it as-is.

- **Local-first:** everything is saved in IndexedDB on the device. Samples are written as they arrive, so a crash or reload loses nothing, and Pulse offers to resume or save an unfinished workout.
- **Optional sync:** sync to your own Supabase project (email sign-in, Row Level Security, and an offline queue that pushes when you're back online).
- **Secrets stay on the device:** the coach token and Supabase keys live only in that browser's `localStorage`. Nothing secret is in this repo.

```
index.html  styles.css  manifest.webmanifest  sw.js  .nojekyll
js/
  app.js           screens, router, glue
  ble.js           Web Bluetooth strap (+ demo strap), auto-reconnect
  hr-parse.js      0x2A37 heart-rate packet parser, 0x2A19 battery
  recorder.js      session state, laps/pauses/gaps, incremental IndexedDB writes
  notes-parser.js  dictated-notes -> chips
  stats.js         zones, calories, summaries, trends, patterns
  charts.js        tiny canvas charts (no chart library needed)
  db.js            IndexedDB wrapper
  sync.js          Supabase sync (supabase-js v2 loaded from a pinned CDN URL only when configured)
  coach.js         OpenClaw chat (OpenAI-compatible, streaming, optional session routing)
  workout-log.js   builds the "PULSE WORKOUT LOG v1" message sent to the coach session
  coach-sync.js    sends each saved workout to the coach; per-session status + retries
  export.js settings.js wakelock.js demo.js
icons/             app icons (SVG + PNG)
supabase/schema.sql
tools/coach-proxy.mjs   tiny CORS proxy for the OpenClaw gateway (runs on your Mac)
tests/unit.test.mjs     parser/stats/SSE unit tests (node --test)
tests/e2e.py            headless Chromium end-to-end test (Playwright)
```

---

## 1. Deploy on GitHub Pages

1. Create a repo (for example `pulse`) and push the contents of this folder to the root of the `main` branch. `index.html` must be at the repo root.
2. On GitHub, go to **Settings → Pages → Build and deployment**, set **Source: Deploy from a branch**, then pick **Branch: `main` / `(root)`** and Save.
3. After about a minute the site is live at `https://<your-user>.github.io/pulse/`. Web Bluetooth needs HTTPS, which GitHub Pages provides.
4. To update the app, push again. The service worker serves the cached copy instantly and refreshes it in the background, so a new version shows up on the second load. If you ever need every device to drop its cache, bump `VERSION` in `sw.js`.

To try it locally, run `python3 -m http.server 8000` and open `http://localhost:8000/?demo=1`. Web Bluetooth also works on `localhost` in Chrome.

### Demo mode

Turn on **Demo strap** on the Start screen, open `?demo=1`, or go to **Settings → Demo mode**. You get a simulated heart rate (it runs through the real packet parser), a **Simulate strap dropout** button on the Live screen, and **Settings → Add demo history** to fill the dashboard. Demo sessions never sync.

---

## 2. Using it

### iPhone (Bluefy)
1. Install **Bluefy – Web BLE Browser** from the App Store and open your Pages URL in it.
2. Optional: add it to your home screen from Bluefy's share menu (`manifest.webmanifest` and the icons are included).
3. Wet the strap electrodes, put the strap on, and tap **Start workout**. The first time, Bluefy shows a device picker: choose "Polar H10 …". After that, Pulse reconnects to the remembered strap through `navigator.bluetooth.getDevices()` without the picker. If that fails, it shows a **Choose strap** button (the picker has to come from a tap).
4. The screen stays awake during a workout. Pulse uses `navigator.wakeLock` and re-acquires it when you come back to the app, plus Bluefy's own `bluetooth.setScreenDimEnabled(false)`.
5. Notes: tap the text box, then tap the 🎤 on the iOS keyboard to dictate. (Pulse also tries the Web Speech API where a browser has it.)
6. Make sure the strap isn't connected to the Polar app (or another app) at the same time. Most straps allow only one or two connections.

### Desktop (Chrome / Edge)
- Open the URL and tap **Start workout**. Chrome shows its Bluetooth picker.
- Silent reconnect needs `navigator.bluetooth.getDevices()`. In current Chrome that may still sit behind `chrome://flags/#enable-web-bluetooth-new-permissions-backend`. Without it, Pulse just shows the picker each time, which takes one click.
- The layout switches to **Desk** automatically at 1024 px or wider. Use the **Desk view / Phone view** button in the top bar, or **Settings → Layout**, to force one.
- Keyboard on the Live screen: **L** marks a lap/set, **Space** pauses or resumes.

### While recording
- If the strap drops out, Pulse shows "Reconnecting… (attempt n)" and retries with exponential backoff (1, 2, 4, 8, 16, then every 30 s) for as long as the workout is running. The timer keeps going, and the gap is marked on the chart and in the data.
- **Pause** stops the timer, and paused time isn't counted. **End** asks for a second tap so a stray touch can't end the workout.

---

## 3. Supabase sync (optional)

1. Create a project at <https://supabase.com> (the free tier is fine).
2. Go to **SQL Editor → New query**, paste `supabase/schema.sql`, and click **Run**. This creates `sessions`, `samples` and `notes`, with indexes and RLS policies so only the signed-in owner (`auth.uid()`) can read or write rows.
3. Go to **Authentication → Sign In / Providers** and make sure **Email** is enabled (it is by default).
4. Go to **Authentication → URL Configuration**. Set **Site URL** to `https://<your-user>.github.io/pulse/` and add the same URL, plus `http://localhost:8000/` if you test locally, to **Redirect URLs**.
5. **Recommended for iPhone:** go to **Authentication → Emails → Magic Link** and add the one-time code to the template, for example `<p>Or enter this code in Pulse: <strong>{{ .Token }}</strong></p>`. On iPhone, a magic link opens in Safari, not Bluefy, so the session would end up in the wrong browser. Typing the 6-digit code into Pulse in Bluefy signs in Bluefy.
6. In **Project Settings → API**, copy the **Project URL** and the **anon / publishable key**. Paste them into Pulse under **Settings → Sync**, enter your email, then tap **Email me a sign-in link** and use the link (desktop) or the code (iPhone).

How sync behaves:
- Finished workouts are pushed whenever you're online and signed in: when you save, when the browser comes back online, and every 5 minutes. Unsynced workouts wait in the local queue.
- Deleting a workout removes its samples and notes remotely and soft-deletes the session (`deleted_at`), so your other devices remove it too on their next sync.
- Workouts from your other devices are pulled down, samples included.
- The anon key is meant to be public. RLS is what protects the data.

---

## 4. OpenClaw coach

Pulse calls your OpenClaw Gateway's OpenAI-compatible endpoint (docs: <https://docs.openclaw.ai/gateway/openai-http-api>):

```
POST {gateway}/v1/chat/completions
Authorization: Bearer <gateway token>
{ "model": "openclaw/default", "stream": true, "messages": [ {role:"system", ...summary...}, ...chat ] }
```

- `openclaw/default` is the documented stable alias for your configured default agent. To target a specific agent, set **Settings → Coach → Agent** to `openclaw/<agentId>`.
- Streaming uses SSE (`data: {json}` lines ending with `data: [DONE]`), and Pulse renders tokens as they arrive.
- Each request carries one system message with the selected session's summary (type, duration, average/max/min HR, time in zones, laps, gaps, your notes and the parsed chips) plus your recent trend stats. The whole chat is re-sent each turn.
- With a **Coach session key** set (section 4c), every request also carries `x-openclaw-session-key`, so it lands in that one OpenClaw session (for example your Telegram coach thread). Without it each request is stateless.
- **Coach** buttons are on the Session and Dashboard screens. Saved workouts are posted to the coach automatically (section 4c), or with **Send to coach** on the session page.

### 4a. Enable the endpoint (on the Mac)

It's off by default. Add this to `~/.openclaw/openclaw.json`:

```json5
{
  gateway: {
    http: { endpoints: { chatCompletions: { enabled: true } } },
  },
}
```

Or run `openclaw config set gateway.http.endpoints.chatCompletions.enabled true`, then restart the gateway.

**Token:** the gateway uses `gateway.auth.mode = "token"` by default. Show the current token with `openclaw gateway auth-token --show` (treat the output as a password), or set one yourself with `gateway.auth.token` or the `OPENCLAW_GATEWAY_TOKEN` environment variable. If no token is configured, the gateway generates a runtime-only one at startup, so set a fixed one. Paste it into **Settings → Coach → Gateway token**. It's stored only in that browser's localStorage.

> ⚠️ OpenClaw's docs say a gateway token on this endpoint is equivalent to **full operator access**. Keep the gateway on loopback/Tailscale only, never on the public internet.

Quick test on the Mac: `curl -sS http://127.0.0.1:18789/v1/models -H "Authorization: Bearer $TOKEN"` should list `openclaw/default`.

### 4b. CORS: why there's a tiny proxy

The gateway listens on port **18789** (`gateway.port`), and its `/v1/chat/completions` handler accepts only `POST`. It answers the browser's CORS preflight (`OPTIONS`) with **405** and sends no `Access-Control-Allow-*` headers. (OpenClaw's `gateway.controlUi.allowedOrigins` setting covers the Control UI and WebSocket only, not this HTTP API.) A page served from `https://<you>.github.io` therefore can't call the gateway directly.

The simplest fix is `tools/coach-proxy.mjs`: an 80-line Node 18+ script with no dependencies. It answers the preflight for your Pulse origin only, forwards `/v1/chat/completions` and `/v1/models` to `127.0.0.1:18789`, and streams the SSE through unchanged. Run it on the Mac and publish it on your tailnet with Tailscale Serve:

```bash
# 1. the proxy (keep it running; see launchd below)
PULSE_ORIGIN=https://<your-user>.github.io node tools/coach-proxy.mjs
#    -> listening on http://127.0.0.1:18790

# 2. tailnet-only HTTPS for it (port 8443 so it doesn't collide with OpenClaw's own Serve on 443)
tailscale serve --bg --https=8443 http://127.0.0.1:18790
tailscale serve status
```

In Pulse, go to **Settings → Coach** and set **Gateway URL** to `https://<mac-name>.<tailnet>.ts.net:8443`, then tap **Test connection**.

- `PULSE_ORIGIN` takes a comma-separated list, for example `https://you.github.io,http://localhost:8000`. The origin has no path: `https://you.github.io`, not `.../pulse/`.
- `OPENCLAW_SESSION_KEY` (optional) is the default coach session for chat requests that don't carry `x-openclaw-session-key` (see 4c). The proxy refuses to start if it uses a reserved prefix. The CORS preflight allows the `x-openclaw-session-key` header.
- Other env vars: `GATEWAY_URL` (default `http://127.0.0.1:18789`) and `PORT` (default `18790`). The proxy stores no token; Pulse's `Authorization: Bearer` header is passed through unchanged.
- Your iPhone and your desk computer must both be on the tailnet (Tailscale app connected). If your tailnet ACLs are restrictive, allow those devices to reach the Mac on TCP **8443**.
- Chrome may ask to **allow access to devices on your local network** the first time a public site calls a Tailscale address. Choose Allow. (The proxy also answers Chrome's Private-Network preflight header.)
- You don't need OpenClaw's own `gateway.tailscale.mode: "serve"` for Pulse. If you use it for the Control UI, it owns HTTPS port 443, which is why the proxy uses 8443.

Keep the proxy running with a LaunchAgent at `~/Library/LaunchAgents/ai.pulse.coach-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.pulse.coach-proxy</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string><string>/Users/YOU/pulse/tools/coach-proxy.mjs</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PULSE_ORIGIN</key><string>https://YOUR-USER.github.io</string>
    <!-- optional: default coach session (your Telegram coach thread) -->
    <key>OPENCLAW_SESSION_KEY</key><string>YOUR-SESSION-KEY</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/ai.pulse.coach-proxy.plist`. Use `which node` for the right path; on Apple Silicon Homebrew it's usually `/opt/homebrew/bin/node`.

### 4c. One coach thread + automatic workout logs

Pulse can talk to **one specific, existing OpenClaw session**, such as the Telegram thread you already use with your coach, and drop every saved workout into it.

1. **Find the session key.** On the Mac, run `openclaw sessions` (or look in the Control UI's session sidebar) and copy the key of your Telegram coach thread. Keys that start with `subagent:`, `cron:` or `acp:` are reserved and rejected by the gateway (HTTP 400).
2. **Tell Pulse.** Either:
   - **Settings → Coach → Coach session key** (stored in that browser's localStorage with the other coach settings; not included in exports), or
   - on the proxy: `OPENCLAW_SESSION_KEY=<key>`. The proxy adds it to `/v1/chat/completions` requests when the browser didn't send one. A key set in Pulse always wins.
3. **Send each workout to coach automatically** (Settings → Coach) is on by default once a session key is set in Pulse. If you only set the key on the proxy, tick it yourself.

What happens when you save a workout (Save notes or Skip):
- The workout, samples and notes are written to IndexedDB first. Then Pulse posts one **non-streaming** message (`stream: false`) into the session: a `PULSE WORKOUT LOG v1` header, an instruction asking the coach to save the log to its workspace (e.g. `fitness/workouts.md` plus `fitness/workouts/<date>-<id>.json`) and reply with a 2–3 sentence takeaway, a human summary, and a fenced `json` block with the structured data (session metadata, zone totals, parsed notes + raw note text, RR/HRV summary such as RMSSD, and the heart rate averaged into 5-second buckets; raw RR intervals are not sent). The `log_id` (the workout's id) lets the coach update instead of duplicating when a log is re-sent.
- The session page shows a small status chip: **Sent to coach**, **Sending…**, **Waiting to send** (offline) or **Coach: not sent** (with the error), plus a **Send to coach** / **Send again** button. The coach's reply appears in a **Coach's take** card and in the session's coach chat.
- If the coach is unreachable, nothing is lost: the log is marked failed and retried the next time Pulse opens (and when the browser comes back online). Delivery status lives in IndexedDB (`coachlog` store).
- Editing notes later doesn't re-send automatically; use **Send again** (the revision number goes up).

---

## 5. Data and formats

- **CSV** (per session): `timestamp,elapsed_s,hr,rr_ms,lap`. `timestamp` is ISO 8601 UTC. `rr_ms` holds the RR intervals in milliseconds, separated by `;` when a packet carries several.
- **JSON** (per session): `{format:"pulse-session", session, notes, samples}`.
- **Settings → Export all** creates a full JSON backup with every session, sample and note, but no tokens. **Import** merges a backup or a single-session export.
- **Zones** default to max HR 190 with Z1 <60%, Z2 60–70%, Z3 70–80%, Z4 80–90% and Z5 >90%. All of it is editable.
- **Calories** are an estimate from heart rate, weight, age and sex (Keytel et al., 2005).

## 6. Tests

```bash
node --test tests/unit.test.mjs                          # 0x2A37 parser, notes parser, stats, SSE, coach log + proxy
pip install playwright && python -m playwright install chromium
python3 -m http.server 8765 &                            # from this folder
python3 tests/e2e.py                                     # CHROMIUM=/path/to/chromium to use a system browser
PULSE_FLOWS=coach_retry_flow python3 tests/e2e.py        # run selected flows only (comma-separated)
```

The end-to-end test drives the demo strap and a scripted fake `navigator.bluetooth` through Start → Connecting → Live (lap, dropout/reconnect, pause) → End → Notes → Session (CSV/JSON) → Coach (auto-sent workout log with session key, then mocked SSE chat) → Dashboard → Settings, plus coach-offline retry and the status chip, crash recovery, delete, Supabase sync (mocked API) and the service worker, at 390 px and 1440 px. It fails on any console error.
