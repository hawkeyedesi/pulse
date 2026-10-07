"""
End-to-end smoke test for Pulse in headless Chromium (demo strap, mocked coach).

  pip install playwright
  python -m http.server 8765 --directory app &      # from the repo root
  CHROMIUM=/usr/bin/chromium python app/tests/e2e.py  # or omit CHROMIUM to use Playwright's bundled browser

Writes screenshots to tests/screenshots/ and exits non-zero on failure.
"""
import asyncio, json, os, re, sys, pathlib, time
from playwright.async_api import async_playwright, expect

BASE = os.environ.get('PULSE_URL', 'http://localhost:8765/')
OUT = pathlib.Path(__file__).parent / 'screenshots'
OUT.mkdir(exist_ok=True)
CHROMIUM = os.environ.get('CHROMIUM')
COACH = 'https://coach.test'
SESSION_KEY = 'agent:main:telegram:dm:424242'
LOG_REPLY = 'Logged it. Solid upper-body session with most time in Z2-Z3. Keep the shoulder honest next time.'
NOTES = ('Upper body day. Bench 4 sets of 8 at 155, felt strong. Pull-ups 3 by 10. '
         'Shoulders tight on the last set. Effort 7 out of 10, slept about 6 hours.')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''))

def sse(text):
    chunks = [text[i:i + 12] for i in range(0, len(text), 12)]
    body = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'
    body += ''.join('data: ' + json.dumps({'choices': [{'delta': {'content': c}}]}) + '\n\n' for c in chunks)
    return body + 'data: [DONE]\n\n'

async def attach(page, label, errors, coach_requests, coach_mode=None):
    coach_mode = coach_mode if coach_mode is not None else {}
    page.on('console', lambda m: errors.append(f'[{label}] console.{m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(f'[{label}] pageerror: {e}'))
    page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))

    async def coach_route(route):
        req = route.request
        if req.method == 'OPTIONS':
            return await route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS'})
        if req.url.endswith('/v1/models'):
            return await route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                                       body=json.dumps({'object': 'list', 'data': [{'id': 'openclaw'}, {'id': 'openclaw/default'}]}))
        body = json.loads(req.post_data or '{}')
        coach_requests.append({'headers': req.headers, 'body': body})
        if coach_mode.get('fail') == 'abort':
            return await route.abort('internetdisconnected')
        if coach_mode.get('fail'):
            # gateway-style agent failure (HTTP 200 + error object) -> the app marks the log failed
            return await route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                                       body=json.dumps({'error': {'message': 'agent unavailable (mock)', 'type': 'api_error'}}))
        if body.get('stream') is False:
            return await route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                                       body=json.dumps({'choices': [{'message': {'role': 'assistant', 'content': LOG_REPLY}, 'finish_reason': 'stop'}]}))
        await route.fulfill(status=200, headers={'content-type': 'text/event-stream', 'access-control-allow-origin': '*'},
                            body=sse('Solid session. **Bench 4×8 @155** looks strong; keep Z4 under 10 min and watch that shoulder.'))
    await page.route(f'{COACH}/**', coach_route)
    # The sandbox browser has no internet: serve empty font CSS instead of hanging.
    await page.route(re.compile(r'https://fonts\.(googleapis|gstatic)\.com/.*'), lambda r: r.fulfill(status=200, content_type='text/css', body=''))

async def no_overflow(page, name):
    ov = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    check(f'{name}: no horizontal overflow', ov <= 1, f'overflow {ov}px')

async def seed_settings(page, session_key=''):
    await page.add_init_script(f"""
      if (!localStorage.getItem('pulse.settings')) localStorage.setItem('pulse.settings', JSON.stringify({{
        demo: true, gatewayUrl: '{COACH}', gatewayToken: 'test-token', coachModel: 'openclaw/default', coachSessionKey: '{session_key}'
      }}));
    """)

def log_requests(coach_requests):
    return [r for r in coach_requests if r['body'].get('stream') is False]

def parse_log(text):
    m = re.search(r'```json\n(.*?)\n```', text, re.S)
    return json.loads(m.group(1)) if m else None

async def record_workout(page, seconds=3500, notes=NOTES):
    await page.goto(BASE + '#/')
    await page.wait_for_selector('#start-btn')
    await page.click('#start-btn')
    await page.wait_for_selector('#screen-live:not([hidden])', timeout=8000)
    await page.wait_for_timeout(seconds)
    await page.click('#end-btn'); await page.click('#end-btn')
    await page.wait_for_selector('#screen-notes:not([hidden])', timeout=5000)
    sid = await page.evaluate("document.querySelector('#notes-text').dataset.sessionId")
    if notes is None:
        await page.click('#skip-notes')
    else:
        await page.fill('#notes-text', notes)
        await page.click('#save-notes')
    await page.wait_for_selector('#screen-session:not([hidden]) h1', timeout=5000)
    return sid

async def chip_status(page):
    return await page.evaluate("document.querySelector('#coach-log-status .coach-chip')?.dataset.status || null")

async def phone_flow(browser, errors):
    ctx = await browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                    service_workers='block', accept_downloads=True)
    page = await ctx.new_page()
    coach_requests = []
    await attach(page, 'phone', errors, coach_requests)
    await seed_settings(page, SESSION_KEY)
    await page.goto(BASE + '?demo=1')
    await page.wait_for_selector('#start-btn')
    check('phone: body uses phone layout', await page.evaluate("document.body.classList.contains('phone')"))
    await page.click('[data-type="Strength"]')
    await page.screenshot(path=str(OUT / 'phone-1-start.png'))
    await no_overflow(page, 'phone start')

    await page.click('#start-btn')
    await page.wait_for_selector('#screen-connecting:not([hidden])', timeout=3000)
    await page.screenshot(path=str(OUT / 'phone-2-connecting.png'))
    await page.wait_for_selector('#screen-live:not([hidden])', timeout=8000)
    check('phone: reached Live from Connecting', True)
    await page.wait_for_timeout(3500)
    await page.click('#lap-btn')
    await page.wait_for_timeout(1500)
    await page.click('#demo-dropout')
    await page.wait_for_timeout(1200)
    chip = await page.inner_text('#conn-chip')
    check('phone: dropout shows reconnecting + timer keeps running', 'Reconnecting' in chip, chip)
    t1 = await page.inner_text('#live-timer')
    await page.wait_for_timeout(2000)
    t2 = await page.inner_text('#live-timer')
    check('phone: timer advances during reconnect', t1 != t2, f'{t1} -> {t2}')
    await page.wait_for_timeout(5000)
    chip = await page.inner_text('#conn-chip')
    check('phone: strap reconnects after dropout', 'connected' in chip.lower(), chip)
    bpm = await page.inner_text('#live-bpm')
    check('phone: live BPM is a number', bpm.isdigit() and 60 < int(bpm) < 200, bpm)
    zone = await page.inner_text('#live-zone')
    check('phone: zone label shown', re.match(r'Z[1-5] · ', zone) is not None, zone)
    await page.evaluate('window.scrollTo(0, 0)')
    await page.screenshot(path=str(OUT / 'phone-3-live.png'))
    fits = await page.evaluate("document.querySelector('#end-btn').getBoundingClientRect().bottom <= window.innerHeight")
    check('phone: live screen controls visible without scrolling (390x844)', fits)
    await no_overflow(page, 'phone live')
    # pause/resume
    await page.click('#pause-btn')
    pt1 = await page.inner_text('#live-timer'); await page.wait_for_timeout(1500); pt2 = await page.inner_text('#live-timer')
    check('phone: pause freezes timer', pt1 == pt2, f'{pt1} / {pt2}')
    await page.click('#pause-btn')
    timer = await page.inner_text('#live-timer')
    secs = sum(int(x) * 60 ** i for i, x in enumerate(reversed(timer.split(':'))))
    check('phone: ran ~10 s or more', secs >= 10, timer)
    # end (double tap)
    await page.click('#end-btn'); await page.click('#end-btn')
    await page.wait_for_selector('#screen-notes:not([hidden])', timeout=5000)
    await page.fill('#notes-text', NOTES)
    await page.wait_for_timeout(400)
    chips = await page.inner_text('#parsed-chips')
    for want in ['Type: Strength', 'Focus: Upper body', 'Bench press 4×8 @155 lb', 'Pull-ups 3×10', 'Effort 7/10', 'Sleep ~6 h', 'Shoulder tightness']:
        check(f'notes chip: {want}', want in chips)
    await page.screenshot(path=str(OUT / 'phone-4-notes.png'))
    await no_overflow(page, 'phone notes')
    await page.click('#save-notes')
    await page.wait_for_selector('#screen-session:not([hidden]) h1', timeout=5000)
    h1 = await page.inner_text('#screen-session h1')
    check('session: header has type + duration', 'Strength' in h1 and re.search(r'\d+:\d\d', h1), h1)
    tiles = await page.inner_text('#screen-session .tiles')
    check('session: stat tiles present', all(k in tiles for k in ['Avg', 'Max', 'Min', 'Calories']), tiles.replace('\n', ' '))
    await page.wait_for_timeout(300)
    await page.screenshot(path=str(OUT / 'phone-5-session.png'), full_page=True)
    await no_overflow(page, 'phone session')
    # CSV
    async with page.expect_download() as dl:
        await page.click('#dl-csv')
    path = await (await dl.value).path()
    csv = pathlib.Path(path).read_text()
    lines = csv.strip().split('\n')
    check('CSV header', lines[0] == 'timestamp,elapsed_s,hr,rr_ms,lap', lines[0])
    check('CSV has >= 8 samples', len(lines) - 1 >= 8, f'{len(lines) - 1} rows')
    check('CSV has a lap-2 row', any(l.endswith(',2') for l in lines[1:]))
    async with page.expect_download() as dl:
        await page.click('#dl-json')
    j = json.loads(pathlib.Path(await (await dl.value).path()).read_text())
    check('JSON export has session/notes/samples', j['format'] == 'pulse-session' and j['notes']['text'] == NOTES and len(j['samples']) >= 8)
    check('session has a recorded gap', len(j['session']['gaps']) >= 1, json.dumps(j['session']['gaps']))
    # Auto-send: the workout log goes into the coach session right after saving
    banner = await page.inner_text('#screen-session .banner')
    check('auto-send: banner reports the coach send (no manual button)', ('Sending it to your coach' in banner or 'Your coach has it' in banner) and await page.locator('#send-coach').count() == 0, banner)
    await page.wait_for_function("document.querySelector('#coach-log-status .coach-chip')?.dataset.status === 'sent'", timeout=8000)
    check('auto-send: status chip shows sent', (await page.inner_text('#coach-log-status')).startswith('Sent to coach'))
    await page.wait_for_function("document.querySelector('#saved-coach-note')?.textContent === 'Your coach has it.'", timeout=3000)
    check('auto-send: banner updates once the coach has it', True)
    logs = log_requests(coach_requests)
    check('auto-send: exactly one non-streaming log request', len(logs) == 1, f'{len(logs)} log requests')
    lr = logs[0] if logs else {'headers': {}, 'body': {}}
    check('auto-send: x-openclaw-session-key header sent', lr['headers'].get('x-openclaw-session-key') == SESSION_KEY, lr['headers'].get('x-openclaw-session-key'))
    check('auto-send: bearer token + model', lr['headers'].get('authorization') == 'Bearer test-token' and lr['body'].get('model') == 'openclaw/default')
    msgs = lr['body'].get('messages') or [{}]
    text = msgs[0].get('content', '')
    check('log: one user message with PULSE WORKOUT LOG v1 header', len(msgs) == 1 and msgs[0].get('role') == 'user' and text.startswith('PULSE WORKOUT LOG v1\nlog_id: '), text[:60])
    check('log: asks coach to save to workspace + 2-3 sentence takeaway', 'save this workout to your workspace training log' in text and '2–3 sentence takeaway' in text)
    check('log: human summary lines', all(k in text for k in ['- When: ', '- Duration: ', '- Heart rate: avg ', '- Time in zones: ', '- Calories: ~', 'Bench press 4×8 @155 lb', 'effort 7/10', '- Notes (raw): "Upper body day.']))
    data = parse_log(text) or {}
    tr = data.get('hr_trace', {})
    check('log JSON: format/version/log_id', data.get('format') == 'pulse-workout-log' and data.get('version') == 1 and data.get('log_id') == j['session']['id'])
    check('log JSON: 5-second HR trace', tr.get('interval_s') == 5 and len(tr.get('points', [])) >= 2 and all(p[0] % 5 == 0 for p in tr['points']), json.dumps(tr)[:120])
    check('log JSON: zones + notes fields', len(data.get('zones', {}).get('zones', [])) == 5 and data.get('notes', {}).get('fields', {}).get('effort') == 7 and data['notes']['text'] == NOTES)
    check('log JSON: no raw RR intervals', '"rr_ms"' not in text)
    await page.wait_for_selector('#coach-takeaway:not([hidden])', timeout=3000)
    check('session: coach takeaway card shows the reply', 'Solid upper-body session' in await page.inner_text('#coach-takeaway'))
    # Coach panel shows the log + reply, then a streamed follow-up in the same session
    await page.click('#open-coach')
    await page.wait_for_selector('#coach:not([hidden]) .msg.log')
    panel = await page.inner_text('#coach-messages')
    check('coach panel: log bubble + coach reply', 'Workout log sent to coach' in panel and 'Solid upper-body session' in panel, panel[:120])
    await page.wait_for_timeout(300)
    await page.screenshot(path=str(OUT / 'phone-7-coach.png'))
    await page.fill('#coach-input', 'What should I do tomorrow?')
    await page.press('#coach-input', 'Enter')
    await page.wait_for_function("document.querySelectorAll('#coach .msg.assistant:not(.streaming)').length >= 2", timeout=8000)
    reply = (await page.locator('#coach .msg.assistant:not(.streaming)').all_inner_texts())[-1]
    check('coach: streamed reply rendered', 'Solid session' in reply and 'watch that shoulder' in reply, reply[:80])
    req = coach_requests[-1] if coach_requests else None
    check('coach: POST body model/stream', req and req['body'].get('model') == 'openclaw/default' and req['body'].get('stream') is True)
    check('coach: bearer token header', req and req['headers'].get('authorization') == 'Bearer test-token')
    check('coach: chat also routed with x-openclaw-session-key', req and req['headers'].get('x-openclaw-session-key') == SESSION_KEY)
    sysmsg = req['body']['messages'][0] if req else {}
    check('coach: system context includes session summary', sysmsg.get('role') == 'system' and 'Type: Strength' in sysmsg.get('content', '') and 'Time in zones' in sysmsg.get('content', '') and 'Bench press 4×8 @155 lb' in sysmsg.get('content', ''))
    check('coach: with session key, only system + newest question sent', req and len(req['body']['messages']) == 2, str(len(req['body']['messages'])) if req else '')
    await page.fill('#coach-input', 'And the day after?')
    await page.press('#coach-input', 'Enter')
    await page.wait_for_function("document.querySelectorAll('#coach .msg.assistant:not(.streaming)').length >= 3", timeout=8000)
    check('coach: follow-up sends only newest turn (OpenClaw keeps history)', [m['role'] for m in coach_requests[-1]['body']['messages']] == ['system','user'] and coach_requests[-1]['body']['messages'][-1]['content'] == 'And the day after?')
    await page.click('#coach-close')

    # Dashboard (one real session), then add demo history
    await page.goto(BASE + '#/settings')
    await page.wait_for_selector('#demo-history')
    await page.screenshot(path=str(OUT / 'phone-8-settings.png'), full_page=True)
    await no_overflow(page, 'phone settings')
    await page.click('#test-coach')
    await page.wait_for_function("document.querySelector('#coach-test-result').textContent.startsWith('Connected')", timeout=5000)
    check('settings: coach test connection via /v1/models', True)
    await page.click('#demo-history')
    await page.wait_for_function("document.querySelector('#toast').textContent.startsWith('Added')", timeout=30000)
    await page.goto(BASE + '#/dashboard')
    await page.wait_for_selector('#ch-weekly')
    await page.wait_for_timeout(500)
    wk = await page.inner_text('#screen-dashboard .tiles')
    check('dashboard: tiles render', 'Workouts this week' in wk and 'Avg session HR' in wk, wk.replace('\n', ' '))
    rows = await page.locator('#screen-dashboard tbody tr[data-href]').count()
    check('dashboard: sessions table has rows', rows >= 2, f'{rows} rows')
    pats = await page.locator('.patterns li').count()
    check('dashboard: patterns computed', pats >= 1, f'{pats} insights')
    await page.screenshot(path=str(OUT / 'phone-6-dashboard.png'), full_page=True)
    await no_overflow(page, 'phone dashboard')
    for r in ['3m', '1y']:
        await page.click(f'[data-range="{r}"]'); await page.wait_for_timeout(200)
    check('dashboard: range toggle works', await page.locator('[data-range="1y"].on').count() == 1)
    await page.click('#dash-coach')
    await page.wait_for_selector('#coach:not([hidden])')
    await page.fill('#coach-input', 'How is my week?')
    await page.press('#coach-input', 'Enter')
    await page.wait_for_selector('#coach .msg.assistant:not(.streaming)', timeout=8000)
    sysmsg = coach_requests[-1]['body']['messages'][0]['content']
    check('coach from dashboard: trend context sent', 'Recent trend' in sysmsg and 'Weekly minutes' in sysmsg)
    await page.click('#coach-close')

    # Crash recovery: start, record a few seconds, reload mid-workout
    await page.goto(BASE + '#/')
    await page.wait_for_selector('#start-btn')
    await page.click('#start-btn')
    await page.wait_for_selector('#screen-live:not([hidden])', timeout=8000)
    await page.wait_for_timeout(4000)
    await page.reload()
    await page.wait_for_selector('#recover-banner:not([hidden])', timeout=5000)
    check('recovery: banner offered after reload mid-workout', True)
    await page.screenshot(path=str(OUT / 'phone-9-recover.png'))
    await page.click('#recover-save')
    await page.wait_for_selector('#screen-notes:not([hidden])', timeout=5000)
    summ = await page.inner_text('#notes-summary')
    check('recovery: saved session keeps samples', 'avg' in summ and '–' not in summ.split('avg')[1][:4], summ)
    await page.click('#skip-notes')
    await page.wait_for_selector('#del-session')
    await page.click('#del-session')
    await page.wait_for_selector('#screen-dashboard:not([hidden])', timeout=5000)
    check('delete: returns to dashboard', True)
    await ctx.close()

async def desk_flow(browser, errors):
    ctx = await browser.new_context(viewport={'width': 1440, 'height': 900}, service_workers='block')
    page = await ctx.new_page()
    desk_requests = []
    await attach(page, 'desk', errors, desk_requests)
    await seed_settings(page)
    await page.goto(BASE)
    await page.wait_for_selector('#start-btn')
    check('desk: auto desk layout at 1440px', await page.evaluate("document.body.classList.contains('desk')"))
    await page.screenshot(path=str(OUT / 'desk-1-start.png'))
    await page.click('#start-btn')
    await page.wait_for_selector('#screen-live:not([hidden])', timeout=8000)
    await page.wait_for_timeout(6000)
    size = await page.evaluate("parseFloat(getComputedStyle(document.querySelector('#live-bpm')).fontSize)")
    check('desk: BPM is huge (readable from 6 ft)', size >= 250, f'{size}px')
    await page.screenshot(path=str(OUT / 'desk-3-live.png'))
    await no_overflow(page, 'desk live')
    await page.click('#end-btn'); await page.click('#end-btn')
    await page.wait_for_selector('#screen-notes:not([hidden])')
    await page.fill('#notes-text', NOTES)
    await page.click('#save-notes')
    await page.wait_for_selector('#screen-session:not([hidden]) h1')
    await page.wait_for_selector('#coach-log-status .coach-chip')
    check('desk: no session key -> auto-send off, chip "not sent" + manual button',
          await chip_status(page) == 'none' and await page.locator('#send-coach').count() == 1 and await page.locator('#coach-send-log').count() == 1
          and not log_requests(desk_requests))
    await page.click('#send-coach')
    await page.wait_for_function("document.querySelector('#coach-log-status .coach-chip')?.dataset.status === 'sent'", timeout=8000)
    await page.wait_for_selector('#coach:not([hidden]) .msg.log', timeout=5000)
    logs = log_requests(desk_requests)
    check('desk: manual "Send to coach" posts the log without a session header',
          len(logs) == 1 and 'x-openclaw-session-key' not in logs[0]['headers'] and logs[0]['body']['messages'][0]['content'].startswith('PULSE WORKOUT LOG v1'))
    await page.click('#coach-close')
    await page.wait_for_timeout(300)
    await page.screenshot(path=str(OUT / 'desk-5-session.png'), full_page=True)
    await page.goto(BASE + '#/settings')
    await page.click('#demo-history')
    await page.wait_for_function("document.querySelector('#toast').textContent.startsWith('Added')", timeout=30000)
    await page.goto(BASE + '#/dashboard')
    await page.wait_for_selector('#ch-weekly'); await page.wait_for_timeout(500)
    await page.screenshot(path=str(OUT / 'desk-6-dashboard.png'), full_page=True)
    await no_overflow(page, 'desk dashboard')
    await page.click('#dash-coach'); await page.wait_for_selector('#coach:not([hidden])')
    await page.wait_for_timeout(500)
    await page.screenshot(path=str(OUT / 'desk-7-coach.png'))
    await ctx.close()


FAKE_BT = r"""
(() => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__bt = { requestCalls: 0, getDevicesCalls: 0, failConnect: false, granted: false, connects: 0 };
  class FakeChar extends EventTarget {
    constructor(uuid) { super(); this.uuid = uuid; this.value = null; }
    async startNotifications() {
      if (this.uuid === 'heart_rate_measurement') {
        clearInterval(this._t);
        this._t = setInterval(() => {
          if (!dev.gatt.connected) return;
          const hr = 120 + Math.round(Math.random() * 5);
          const rr = Math.round((60000 / hr) * 1024 / 1000);
          this.value = new DataView(new Uint8Array([0x16, hr, rr & 255, rr >> 8]).buffer);
          this.dispatchEvent(new Event('characteristicvaluechanged'));
        }, 1000);
      }
      return this;
    }
    async stopNotifications() { clearInterval(this._t); }
    async readValue() { return new DataView(new Uint8Array([77]).buffer); }
  }
  const hrChar = new FakeChar('heart_rate_measurement');
  const batChar = new FakeChar('battery_level');
  const server = {
    async getPrimaryService(name) {
      if (name === 'heart_rate') return { getCharacteristic: async (c) => { if (c !== 'heart_rate_measurement') throw new Error('nochar'); return hrChar; } };
      if (name === 'battery_service') return { getCharacteristic: async () => batChar };
      throw new Error('no service ' + name);
    },
  };
  const dev = new EventTarget();
  dev.id = 'fake-h10'; dev.name = 'Polar H10 0A1B2C3D';
  dev.gatt = {
    connected: false,
    async connect() { await delay(150); if (window.__bt.failConnect) throw new Error('NetworkError: connection failed'); this.connected = true; window.__bt.connects++; return server; },
    disconnect() { this.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  window.__dropStrap = () => { dev.gatt.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); };
  const bt = {
    async requestDevice(opts) { window.__bt.requestCalls++; window.__bt.opts = opts; window.__bt.granted = true; await delay(100); return dev; },
    async getDevices() { window.__bt.getDevicesCalls++; return window.__bt.granted || localStorage.getItem('pulse.strap') ? [dev] : []; },
    async getAvailability() { return true; },
  };
  Object.defineProperty(Navigator.prototype, 'bluetooth', { get: () => bt, configurable: true });
})();
"""

async def fake_ble_flow(browser, errors):
    ctx = await browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
    page = await ctx.new_page()
    await attach(page, 'fakeble', errors, [])
    await page.add_init_script(FAKE_BT)
    await page.add_init_script("if (!localStorage.getItem('pulse.settings')) localStorage.setItem('pulse.settings', JSON.stringify({demo: false}));")
    await page.goto(BASE)
    await page.wait_for_selector('#start-btn')
    await page.click('#start-btn')
    await page.wait_for_selector('#screen-live:not([hidden])', timeout=8000)
    opts = await page.evaluate('window.__bt.opts')
    check('BLE: requestDevice filters heart_rate + optional battery_service',
          opts == {'filters': [{'services': ['heart_rate']}], 'optionalServices': ['battery_service']}, json.dumps(opts))
    await page.wait_for_timeout(2500)
    chip = await page.inner_text('#conn-chip')
    check('BLE: battery level read (0x2A19)', 'battery 77%' in chip, chip)
    bpm = await page.inner_text('#live-bpm')
    check('BLE: HR from parsed 0x2A37 notifications', bpm.isdigit() and 120 <= int(bpm) <= 125, bpm)
    await page.evaluate('window.__bt.failConnect = true; window.__dropStrap()')
    await page.wait_for_timeout(4200)
    chip = await page.inner_text('#conn-chip')
    check('BLE: exponential retry while workout active', 'Reconnecting' in chip and re.search(r'attempt [3-9]', chip) is not None, chip)
    await page.evaluate('window.__bt.failConnect = false')
    await page.wait_for_function("document.querySelector('#conn-chip').textContent.includes('connected')", timeout=12000)
    check('BLE: reconnects after strap comes back', True)
    await page.wait_for_timeout(1500)
    await page.click('#end-btn'); await page.click('#end-btn')
    await page.wait_for_selector('#screen-notes:not([hidden])')
    sid = await page.evaluate("document.querySelector('#notes-text').dataset.sessionId")
    sess = await page.evaluate(f"window.__pulse.db.get('sessions', '{sid}')")
    check('BLE: gap recorded for the dropout', len(sess['gaps']) == 1 and sess['gaps'][0]['end'], json.dumps(sess['gaps']))
    check('BLE: device remembered', sess['device']['name'] == 'Polar H10 0A1B2C3D')
    samples = await page.evaluate(f"window.__pulse.db.getSamples('{sid}')")
    check('BLE: samples stored with RR intervals', len(samples) >= 3 and all(len(x['rr_ms']) == 1 for x in samples), f'{len(samples)} samples')
    await page.click('#skip-notes')
    await page.goto(BASE + '#/')
    await page.wait_for_selector('#start-btn')
    strap_chip = await page.inner_text('#strap-chip')
    check('BLE: start screen shows remembered strap', 'Polar H10' in strap_chip, strap_chip)
    before = await page.evaluate('window.__bt.requestCalls')
    await page.click('#start-btn')
    await page.wait_for_selector('#screen-live:not([hidden])', timeout=12000)
    after = await page.evaluate('window.__bt.requestCalls')
    check('BLE: silent reconnect via getDevices() (no picker on 2nd start)', after == before and await page.evaluate('window.__bt.getDevicesCalls') >= 1, f'requestDevice calls {before}->{after}')
    await page.click('#end-btn'); await page.click('#end-btn')
    await page.wait_for_selector('#screen-notes:not([hidden])')
    await ctx.close()

async def coach_retry_flow(browser, errors):
    ctx = await browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, service_workers='block')
    page = await ctx.new_page()
    reqs = []
    mode = {'fail': True}
    await attach(page, 'retry', errors, reqs, mode)
    await seed_settings(page, SESSION_KEY)
    sid = await record_workout(page, seconds=3000)
    await page.wait_for_function("document.querySelector('#coach-log-status .coach-chip')?.dataset.status === 'failed'", timeout=8000)
    chip = await page.inner_text('#coach-log-status')
    check('retry: coach failure -> chip "not sent" + error + Send to coach button', 'Coach: not sent' in chip and 'agent unavailable' in chip and await page.locator('#coach-send-log').inner_text() == 'Send to coach', chip.replace('\n', ' '))
    rec = await page.evaluate(f"window.__pulse.db.get('coachlog', '{sid}')")
    check('retry: IndexedDB record failed, attempts 1', rec and rec['status'] == 'failed' and rec['attempts'] == 1, json.dumps(rec)[:160])
    sess = await page.evaluate(f"window.__pulse.db.get('sessions', '{sid}')")
    notes = await page.evaluate(f"window.__pulse.db.get('notes', '{sid}')")
    samples = await page.evaluate(f"window.__pulse.db.getSamples('{sid}').then(x => x.length)")
    check('retry: workout, notes and samples saved despite coach failure', sess and sess['status'] == 'complete' and notes and notes['text'] == NOTES and samples >= 2, f'{samples} samples')
    await page.screenshot(path=str(OUT / 'phone-10-coach-failed.png'))
    # network failure on manual retry (coach offline)
    mode['fail'] = 'abort'
    await page.click('#coach-send-log')
    await page.wait_for_function(f"window.__pulse.db.get('coachlog', '{sid}').then(r => r && r.status === 'failed' && r.attempts === 2)", timeout=8000)
    check('retry: manual retry while offline stays failed (attempts 2)', True)
    # coach comes back: reopening the app retries pending/failed logs
    mode['fail'] = False
    n_before = len(log_requests(reqs))
    await page.reload()
    await page.wait_for_function(f"window.__pulse.db.get('coachlog', '{sid}').then(r => r && r.status === 'sent')", timeout=10000)
    check('retry: next app open re-sends and marks it sent', len(log_requests(reqs)) == n_before + 1)
    last = log_requests(reqs)[-1]
    check('retry: re-send carries the session key and same log_id', last['headers'].get('x-openclaw-session-key') == SESSION_KEY and (parse_log(last['body']['messages'][0]['content']) or {}).get('log_id') == sid)
    await page.wait_for_function("document.querySelector('#coach-log-status .coach-chip')?.dataset.status === 'sent'", timeout=5000)
    check('retry: chip updates to sent with "Send again"', await page.locator('#coach-send-log').inner_text() == 'Send again')
    await page.screenshot(path=str(OUT / 'phone-11-coach-sent.png'), full_page=True)
    # skip-notes still sends (no notes in payload)
    sid2 = await record_workout(page, seconds=2500, notes=None)
    await page.wait_for_function("document.querySelector('#coach-log-status .coach-chip')?.dataset.status === 'sent'", timeout=8000)
    d2 = parse_log(log_requests(reqs)[-1]['body']['messages'][0]['content']) or {}
    check('retry: skipped notes -> log still sent with notes null', d2.get('log_id') == sid2 and d2.get('notes') is None)
    # settings: session key + toggle
    await page.goto(BASE + '#/settings')
    await page.wait_for_selector('#coach-autosend')
    check('settings: session key field + auto-send toggle (on with key)', await page.input_value('input[name=coachSessionKey]') == SESSION_KEY and await page.is_checked('#coach-autosend'))
    await page.fill('input[name=coachSessionKey]', 'cron:nightly')
    await page.wait_for_timeout(500)
    check('settings: reserved session key warns', 'reserved' in await page.inner_text('#session-key-hint'))
    await page.fill('input[name=coachSessionKey]', SESSION_KEY)
    await page.uncheck('#coach-autosend')
    await page.wait_for_timeout(500)
    saved = await page.evaluate("JSON.parse(localStorage.getItem('pulse.settings'))")
    check('settings: key + explicit auto-send=false stored in localStorage', saved.get('coachSessionKey') == SESSION_KEY and saved.get('coachAutoSend') is False)
    n = len(log_requests(reqs))
    await record_workout(page, seconds=2500, notes=None)
    await page.wait_for_selector('#coach-log-status .coach-chip')
    await page.wait_for_timeout(800)
    check('settings: auto-send off -> nothing posted, chip "not sent"', len(log_requests(reqs)) == n and await chip_status(page) == 'none')
    await ctx.close()

SB = 'https://sb.test'
async def sync_flow(browser, errors):
    import urllib.request
    ctx = await browser.new_context(viewport={'width': 800, 'height': 900}, service_workers='block')
    page = await ctx.new_page()
    await attach(page, 'sync', errors, [])
    cdn_cache = {}
    async def cdn(route):
        url = route.request.url
        if url not in cdn_cache:
            cdn_cache[url] = await asyncio.to_thread(lambda: urllib.request.urlopen(url, timeout=30).read())
        await route.fulfill(status=200, content_type='application/javascript', body=cdn_cache[url], headers={'access-control-allow-origin': '*'})
    await page.route('https://cdn.jsdelivr.net/**', cdn)
    rest = []
    user = {'id': '11111111-1111-4111-8111-111111111111', 'aud': 'authenticated', 'role': 'authenticated', 'email': 'me@example.com',
            'app_metadata': {}, 'user_metadata': {}, 'created_at': '2026-01-01T00:00:00Z'}
    async def sb(route):
        req = route.request
        cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'}
        if req.method == 'OPTIONS':
            return await route.fulfill(status=204, headers=cors)
        if '/auth/v1/otp' in req.url:
            rest.append(('OTP', req.url, req.post_data))
            return await route.fulfill(status=200, headers=cors, content_type='application/json', body='{}')
        if '/auth/v1/verify' in req.url:
            rest.append(('VERIFY', req.url, req.post_data))
            body = {'access_token': 'header.eyJzdWIiOiIxIn0.sig', 'token_type': 'bearer', 'expires_in': 3600,
                    'expires_at': int(time.time()) + 3600, 'refresh_token': 'r1', 'user': user}
            return await route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps(body))
        if '/auth/v1/user' in req.url:
            return await route.fulfill(status=200, headers=cors, content_type='application/json', body=json.dumps(user))
        if '/rest/v1/' in req.url:
            rest.append((req.method, req.url, req.post_data))
            if req.method == 'GET':
                return await route.fulfill(status=200, headers=cors, content_type='application/json', body='[]')
            return await route.fulfill(status=201, headers=cors, content_type='application/json', body='[]')
        await route.fulfill(status=404, headers=cors, body='')
    await page.route(f'{SB}/**', sb)
    await page.add_init_script(f"""if (!localStorage.getItem('pulse.settings')) localStorage.setItem('pulse.settings', JSON.stringify({{
        demo: true, supabaseUrl: '{SB}', supabaseAnonKey: 'anon-test-key' }}));""")
    await page.goto(BASE + '#/settings')
    await page.wait_for_selector('#auth-email', timeout=15000)
    await page.fill('#auth-email', 'me@example.com')
    await page.click('#send-link')
    await page.wait_for_timeout(800)
    otp = [r for r in rest if r[0] == 'OTP']
    check('sync: magic link requested (signInWithOtp)', otp and 'me@example.com' in (otp[0][2] or '') and 'redirect_to=' in otp[0][1], otp[0][1] if otp else '')
    await page.fill('#auth-code', '123456')
    await page.click('#verify-code')
    await page.wait_for_selector('#sync-now', timeout=8000)
    check('sync: 6-digit code sign-in (verifyOtp)', True)
    # record a short workout, save it, and watch the upserts
    await page.goto(BASE + '#/')
    await page.wait_for_selector('#start-btn')
    await page.click('#start-btn')
    await page.wait_for_selector('#screen-live:not([hidden])', timeout=8000)
    await page.wait_for_timeout(3500)
    await page.click('#end-btn'); await page.click('#end-btn')
    await page.wait_for_selector('#screen-notes:not([hidden])')
    await page.fill('#notes-text', NOTES)
    await page.click('#save-notes')
    for _ in range(50):
        if any(r[0] == 'POST' and '/rest/v1/notes' in r[1] for r in rest): break
        await page.wait_for_timeout(200)
    await page.wait_for_timeout(300)
    posts = [r for r in rest if r[0] == 'POST']
    print('   sync requests:', [(r[0], r[1].split('/v1/')[1][:50]) for r in rest])
    tables = [re.search(r'/rest/v1/(\w+)', r[1]).group(1) for r in posts]
    check('sync: upserts sessions, samples, notes', all(t in tables for t in ['sessions', 'samples', 'notes']), ','.join(tables))
    srow = json.loads([r for r in posts if '/sessions' in r[1]][0][2])
    srow = srow[0] if isinstance(srow, list) else srow
    check('sync: session row shape', all(k in srow for k in ['id', 'started_at', 'avg_hr', 'zone_seconds', 'laps']) and 'user_id' not in srow)
    smp = json.loads([r for r in posts if '/samples' in r[1]][0][2])
    check('sync: sample rows shape', isinstance(smp, list) and {'session_id', 'seq', 't', 'hr', 'rr_ms'} <= set(smp[0].keys()))
    check('sync: upsert uses on_conflict', any('on_conflict=session_id%2Cseq' in r[1] or 'on_conflict=session_id,seq' in r[1] for r in posts))
    # delete propagates through outbox
    sid = srow['id']
    await page.click('#del-session')
    await page.wait_for_timeout(1500)
    dels = [r for r in rest if r[0] in ('DELETE', 'PATCH')]
    check('sync: delete -> remote delete samples/notes + soft-delete session', len(dels) >= 3 and any(r[0] == 'PATCH' and sid in r[1] for r in dels), str([(r[0], r[1].split('/rest/v1/')[1][:40]) for r in dels]))
    await ctx.close()

async def sw_check(browser, errors):
    ctx = await browser.new_context(viewport={'width': 800, 'height': 900})
    page = await ctx.new_page()
    await attach(page, 'sw', errors, [])
    await page.goto(BASE)
    await page.wait_for_selector('#start-btn')
    ok = await page.evaluate("navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false)")
    check('service worker registers and activates', ok)
    manifest = await page.evaluate("fetch('manifest.webmanifest').then(r => r.json()).then(j => j.icons.length)")
    check('manifest loads with icons', manifest >= 3)
    await ctx.close()

async def main():
    errors = []
    async with async_playwright() as p:
        kw = {'args': ['--no-sandbox']}
        if CHROMIUM: kw['executable_path'] = CHROMIUM
        browser = await p.chromium.launch(**kw)
        flows = (phone_flow, desk_flow, coach_retry_flow, fake_ble_flow, sync_flow, sw_check)
        only = [x.strip() for x in os.environ.get('PULSE_FLOWS', '').split(',') if x.strip()]
        for flow in flows:
            if only and flow.__name__ not in only: continue
            try:
                await flow(browser, errors)
            except Exception as e:
                check(f'{flow.__name__} completed without exception', False, repr(e)[:400])
        await browser.close()
    relevant = [e for e in errors if 'fonts.g' not in e]
    check('no console errors / page errors', not relevant, '\n'.join(relevant[:20]))
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    sys.exit(1 if failed else 0)

asyncio.run(main())
