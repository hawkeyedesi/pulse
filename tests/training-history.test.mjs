import test from 'node:test';
import assert from 'node:assert/strict';
import { historyItem, loadHistory } from '../js/training-history.js';

const memory = () => {
  const values = new Map();
  return { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
};
function clientFor(pages, failure = false) {
  const calls = [];
  const c = { calls, from: table => {
    assert.equal(table, 'workouts');
    const q = { select: () => q, eq: (k, v) => { calls.push([k, v]); return q; }, is: () => q, order: () => q,
      range: async (a, b) => { calls.push([a, b]); return failure ? { error: { message: 'offline' } } : { data: pages[a / 500] || [] }; } };
    return q;
  } };
  return c;
}

test('date-only partial and recovery records do not acquire fake time or completion', () => {
  const raw = { session_name: 'Partial', duration_min: null, actual_summary: '5 rounds; rest skipped' };
  const h = historyItem({ date: '2026-03-23', status: 'done', history_json: { source_status: { completed: 0 }, raw } });
  assert.equal(h.duration, null);
  assert.equal(h.status, 'Activity logged · plan partially completed');
  assert.equal(h.summary, raw.actual_summary);
  assert.equal(h.record.raw, raw);
  assert.equal('startedAt' in h, false);
});
test('native recording remains a link with measured duration, not another session', () => {
  const h = historyItem({ source: 'pulse', log_id: 'native', history_json: { raw: { number: 61 }, pulse_payload: { duration_s: 706 } } });
  assert.equal(h.nativeLogId, 'native');
  assert.equal(h.duration, '11 min 46 s (recorded)');
});
test('history pagination is complete and owner-filtered', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ id: i, user_id: 'owner' }));
  const c = clientFor([rows.slice(0, 500), rows.slice(500)]);
  const r = await loadHistory(c, 'owner', memory());
  assert.equal(r.rows.length, 501);
  assert.equal(r.cached, false);
  assert.deepEqual(c.calls, [['user_id', 'owner'], [0, 499], ['user_id', 'owner'], [500, 999]]);
});
test('offline cache is scoped to the signed-in owner and unavailable when signed out', async () => {
  const storage = memory();
  await loadHistory(clientFor([[{ id: 1, user_id: 'owner' }]]), 'owner', storage);
  assert.equal((await loadHistory(clientFor([], true), 'owner', storage)).cached, true);
  await assert.rejects(loadHistory(clientFor([], true), 'other', storage));
  assert.deepEqual((await loadHistory(null, null, storage)).rows, []);
});
test('a response for another owner is rejected, not cached', async () => {
  await assert.rejects(loadHistory(clientFor([[{ user_id: 'other' }]]), 'owner', memory()), /Unexpected history owner/);
});
