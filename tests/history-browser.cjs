// Local-only UI verification; synthetic fixtures and mocked account transport.
// PLAYWRIGHT_MODULE=/path/to/playwright-core node tests/history-browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const BASE = process.env.PULSE_URL || 'http://127.0.0.1:8766/';
const rows = Array.from({ length: 65 }, (_, i) => ({
  id: `report-${i}`, user_id: 'owner', date: '2026-03-23', source: 'manual', status: i % 3 ? 'done' : 'skip',
  deleted_at: null, history_json: { id: `report-${i}`, source_status: { completed: i % 3 ? 1 : 0 },
    raw: { session_name: i ? `Training report ${i}` : 'Partial <script>bad()</script>', duration_min: null,
      actual_summary: 'Reported activity only; future plans are not completed activity.', notes: 'Original notes', planned_summary: 'Uncompleted plan' },
    exercises: [{ exercise: 'Example movement', sets: [{ reps: 5 }] }] },
}));
const mock = `const rows=${JSON.stringify(rows)};
export const syncConfigured=()=>true;
export const currentUser=async()=>window.historyUser===null?null:{id:window.historyUser||'owner'};
export const getClient=async()=>({from:table=>{if(table!=='workouts')throw Error('wrong table');let owner;const q={select:()=>q,eq:(k,v)=>(owner=v,q),is:()=>q,order:()=>q,range:async(a,b)=>window.historyOffline?{error:{message:'offline'}}:{data:rows.filter(r=>r.user_id===owner).slice(a,b+1)}};return q;}});
export const syncStatus=()=>({state:'ok',message:'Synced'});
export const onSyncStatus=fn=>(fn(syncStatus()),()=>{});
export const startAutoSync=()=>{};
export const syncNow=async()=>{};
export const pendingCount=async()=>0;`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/js/sync.js', r => r.fulfill({ contentType: 'text/javascript', body: mock }));
      await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, r => r.fulfill({ contentType: 'text/css', body: '' }));
      await page.goto(BASE + '#/history');
      await page.waitForFunction(() => document.querySelectorAll('.history-record').length === 65);
      assert.equal(await page.locator('.history-record').count(), 65);
      assert.ok(await page.locator('#screen-history').innerText().then(t => t.includes('Duration not reported')));
      assert.equal(await page.locator('.history-record script').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal((await page.evaluate(() => window.__pulse.db.getAll('sessions'))).length, 0);
      await page.evaluate(() => { window.historyOffline = true; });
      await page.locator('#history-refresh').click();
      await page.waitForFunction(() => document.querySelector('#screen-history').innerText.includes('Saved copy'));
      assert.equal(await page.locator('.history-record').count(), 65);
      await page.evaluate(() => { window.historyUser = 'other'; window.historyOffline = false; });
      await page.locator('#history-refresh').click();
      await page.waitForFunction(() => document.querySelector('#screen-history').innerText.includes('No coach history'));
      assert.equal(await page.locator('.history-record').count(), 0);
      await page.evaluate(() => { window.historyUser = null; });
      await page.locator('#history-refresh').click();
      await page.waitForFunction(() => document.querySelector('#screen-history').innerText.includes('Sign in to your Supabase'));
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px fresh context: 65 reports, no synthetic sessions, no overflow, escaped notes, offline cache, account isolation, signed-out state`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
