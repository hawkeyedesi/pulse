import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../tools/coach-local.mjs';

test('Pulse bridge authenticates, pins routing, streams, retries delivery without another coach run', async t => {
  let calls = 0, mirrors = 0, lastBody, lastHeaders, fail = true;
  const upstream = http.createServer(async (req, res) => {
    calls++; lastHeaders = req.headers;
    if (req.method === 'GET') { res.end(JSON.stringify({data:[]})); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    lastBody = JSON.parse(Buffer.concat(chunks));
    if (lastBody.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'); }
    else res.end(JSON.stringify({ choices: [{ message: { content: 'Demo test received.' } }] }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const bridge = createBridge({ token:'pulse-only', gatewayToken:'server-only', sessionKey:'workout', origin:'https://pulse-hr.pages.dev', upstream:`http://127.0.0.1:${upstream.address().port}`, mirror:async () => {mirrors++; if(fail) throw new Error('mirror offline');} });
  await new Promise(r => bridge.listen(0, '127.0.0.1', r));
  t.after(() => {bridge.closeAllConnections();bridge.close();upstream.closeAllConnections();upstream.close();});
  const base = `http://127.0.0.1:${bridge.address().port}`;
  const headers = { Authorization:'Bearer pulse-only', 'Content-Type':'application/json', Origin:'https://pulse-hr.pages.dev' };
  const post = (content, extra={}) => fetch(base+'/v1/chat/completions', {method:'POST',headers, body:JSON.stringify({messages:[{role:'user',content}],...extra})});
  await t.test('bad token and origin blocked; browser preflight accepted', async () => {
    assert.equal((await fetch(base+'/v1/models')).status,401);
    assert.equal((await fetch(base+'/v1/models',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
    const pre=await fetch(base+'/v1/chat/completions',{method:'OPTIONS',headers:{Origin:headers.Origin}});
    assert.equal(pre.status,204); assert.equal(pre.headers.get('access-control-allow-origin'),headers.Origin);
    assert.equal(calls,0);
  });
  await t.test('session escapes, unknown paths and invalid JSON rejected', async () => {
    assert.equal((await fetch(base+'/v1/models',{headers:{...headers,'x-openclaw-session-key':'other'}})).status,403);
    assert.equal((await fetch(base+'/admin',{headers})).status,404);
    assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:'invalid'})).status,400);
  });
  await t.test('gateway health is checked, credential replaced', async () => {
    assert.equal((await fetch(base+'/v1/models',{headers})).status,200);
    assert.equal(lastHeaders.authorization,'Bearer server-only');
  });
  await t.test('failed Telegram delivery retries cached answer and deduplicates repeats', async () => {
    const before=calls;
    assert.equal((await post('PULSE WORKOUT LOG v1\nconnection test',{model:'openclaw/other'})).status,502);
    assert.equal(lastBody.model,'openclaw/main'); assert.equal(lastHeaders['x-openclaw-session-key'],'workout');
    fail=false;
    assert.equal((await post('PULSE WORKOUT LOG v1\nconnection test')).status,200);
    assert.equal((await post('PULSE WORKOUT LOG v1\nconnection test')).status,200);
    assert.equal(calls,before+1); assert.equal(mirrors,2);
  });
  await t.test('interactive coaching streams without a Telegram mirror', async () => {
    const res=await post('Hi',{stream:true}); assert.equal(res.status,200);
    assert.match(await res.text(),/hello/); assert.equal(mirrors,2);
  });
});
