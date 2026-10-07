# Connect an existing Telegram workout thread

This is the recommended private, single-user integration. Requires **Node 22+**,
OpenClaw on the same Mac, and Tailscale on both the Mac and the device using Pulse.
No npm dependencies. Keep the Mac awake while using the coach; no sleep settings
are changed by this script.

## Why this bridge exists

Pulse → Tailscale HTTPS → loopback bridge `:18790` → OpenClaw `:18789` → existing
workout conversation. Saved-workout replies are explicitly mirrored to Telegram.
Interactive chat replies stream to Pulse and remain in the shared agent history;
they are not separately mirrored into Telegram.

The OpenClaw Chat Completions endpoint runs with automatic channel delivery
disabled. A session header selects conversation history, not a Telegram send.
The older `coach-proxy.mjs` is a CORS-only passthrough; it does not solve delivery.

## Setup

1. Enable the gateway endpoint:

   ```sh
   openclaw config set gateway.http.endpoints.chatCompletions.enabled true
   ```

   Follow the command's reload guidance. Keep the gateway loopback-only.

2. Ensure `OPENCLAW_GATEWAY_TOKEN` is available to the bridge process, or already
   configured in `~/.openclaw/.env`. Do not put that credential in the Pulse browser,
   repo, or LaunchAgent. This bridge does not resolve OpenClaw SecretRefs itself.

3. Start the bridge from your checkout, using your actual origin and session key:

   ```sh
   PULSE_ORIGIN=https://your-pulse.pages.dev \
   OPENCLAW_SESSION_KEY='agent:main:telegram:group:YOUR_CHAT_ID:topic:YOUR_TOPIC_ID' \
   node tools/coach-local.mjs
   ```

   Replace both ID placeholders with numeric IDs. `openclaw sessions` can help you
   find the existing key. The script requires a Telegram group/topic key, derives
   the agent and destination from it, and locks routing to that session.

4. Publish only to your tailnet (not Tailscale Funnel):

   ```sh
   tailscale serve --bg --https=8443 http://127.0.0.1:18790
   tailscale serve status
   ```

5. In Pulse **Settings → Coach**, set:

   - **Gateway URL:** the private HTTPS `:8443` URL printed above.
   - **Gateway token:** the dedicated **Pulse token**, despite the existing label.
     It is generated at `~/.openclaw/pulse/proxy-token`; copy it on the Mac with
     `cat ~/.openclaw/pulse/proxy-token | pbcopy`.
   - **Agent:** `openclaw/main`, or the agent named in your session key.
   - **Coach session key:** the same session key used by the bridge.
   - **Send each workout to coach automatically:** on.

   Settings are per browser, not synchronized to another device. Click **Test
   connection** and allow browser local-network access when prompted. This test
   checks the bridge's authentication to the upstream gateway, not just the proxy.

6. Record about a minute with **Demo strap**, label the notes clearly as a test,
   and save. Verify **Sending → Sent to coach**, a visible **Coach's take**, and a
   message in the Telegram topic. Check that the coach did not add the demo to your
   actual training records, then turn Demo strap back off.

## Run at login on macOS

Use the LaunchAgent example in the main README with these changes:

- `ProgramArguments`: your absolute Node 22+ path and absolute
  `tools/coach-local.mjs` path (not `coach-proxy.mjs`).
- `EnvironmentVariables`: `PULSE_ORIGIN`, `OPENCLAW_SESSION_KEY`, and `PATH` including
  your Node/OpenClaw install directory (often `/opt/homebrew/bin`). No credentials.
- `RunAtLoad` and `KeepAlive`: true.
- Optionally set `StandardOutPath` / `StandardErrorPath` outside the repository.

Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.pulse.coach-proxy.plist`.
Do not run both proxies on port 18790. Keep an existing working service until the
replacement configuration has been checked.

Optional environment variables:

- `PORT`: loopback listener, default `18790`.
- `GATEWAY_URL`: loopback HTTP origin, default `http://127.0.0.1:18789`.
- `PULSE_STATE_DIR`: token/cache directory, default `~/.openclaw/pulse`. Keep it
  private and outside the checkout. Use a separate directory per coach thread.
- `OPENCLAW_ACCOUNT`: Telegram account, default `default`.
- `OPENCLAW_BIN`: CLI executable, default `openclaw` from `PATH`.

## Contracts and limitations

- Only one origin, agent and session are accepted. Browser-provided model/tool
  overrides are dropped; only text messages and streaming choice are passed on.
  Request bodies are capped at 1 MiB.
- The full gateway credential stays server-side. The dedicated Pulse token is
  still sensitive: the main coach retains its ordinary tools. Session pinning is
  not a tool sandbox or a multi-user authorization system.
- Simulated/test workouts are excluded from real training records by the coach's
  instructions. Real workouts should use the existing canonical training store
  and deduplicate on `log_id`/revision. Persistence remains agent-driven, not a
  schema-enforced database transaction; manually verify the first real workout.
- Exact saved-workout text is cached privately. A failed Telegram send can retry
  the cached answer without rerunning the coach. A completed identical request
  reuses its response without sending a duplicate. Changed text/timestamps form a
  new cache key. Delivery is not exactly-once across a crash between the send and
  the cache write. Cached replies can contain private health data.
- The gateway call times out after 175 seconds; a Telegram CLI send may take up to
  another 30 seconds. Pulse's own 180-second timeout can fire first; retrying the
  same saved-workout text recovers the cached response/delivery state.
- Stop exposure with `tailscale serve --https=8443 off`. Stop the LaunchAgent with
  `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.pulse.coach-proxy.plist`.

## Verify

```sh
node --test tests/*.test.mjs
```

Focused bridge tests cover unauthorized callers/origins, CORS preflight, invalid
requests, fixed routing, gateway credential replacement, Telegram failure/retry
without another model run, deduplication, and streamed interactive responses.
