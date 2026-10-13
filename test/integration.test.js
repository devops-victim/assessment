import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { seededTrades, signature, integerEnv } from '../src/common.js';
import { system, waitSnapshot, waitJob } from './helpers.js';

test('seeded exchange records are deterministic and contain valid required fields', () => {
  const records = seededTrades(0, 3000);
  assert.equal(records.length, 3000); assert.deepEqual(records, seededTrades(0, 3000));
  assert.equal(new Set(records.map(t => t.tradeId)).size, 3000);
  assert.ok(records.every(t => t.quantity > 0 && t.price > 0 && t.client && t.symbol && Number.isFinite(Date.parse(t.timestamp))));
  assert.equal(integerEnv(undefined, 900000, 'delay'), 900000);
  assert.throws(() => integerEnv('-1', 0, 'delay', 0));
});

test('POST accepts immediately; job channels notify two clients, then HTTP downloads the report', async t => {
  const s = await system({ delayMs: 700 }); t.after(() => s.close());
  assert.equal(s.app.store.trades().length, 0);
  const began = performance.now();
  const response = await fetch(s.url + '/api/pulls', { method: 'POST' }); const body = await response.json();
  assert.equal(response.status, 202); assert.ok(performance.now() - began < 500);
  assert.equal(body.job_id, body.job.id); assert.equal(body.websocket_url, `/live?job_id=${body.job_id}`);
  const a = new WebSocket(s.url.replace('http:', 'ws:') + body.websocket_url);
  const b = new WebSocket(s.url.replace('http:', 'ws:') + body.websocket_url);
  t.after(() => { a.terminate(); b.terminate(); });
  const frames = []; a.on('message', raw => frames.push(JSON.parse(raw.toString())));
  const completions = Promise.all([waitJob(a, d => d.status === 'completed'), waitJob(b, d => d.status === 'completed')]);
  const early = await fetch(s.url + `/api/pulls/${body.job_id}/trades`); assert.equal(early.status, 409);
  const saved = await (await fetch(s.url + '/api/trades')).json(); assert.equal(saved.trades.length, 0);
  const duplicate = await (await fetch(s.url + '/api/pulls', { method: 'POST' })).json();
  assert.equal(duplicate.job_id, body.job_id); assert.equal(duplicate.alreadyRunning, true);
  const [done, other] = await completions;
  assert.equal(done.job_id, body.job_id); assert.equal(other.download_url, done.download_url);
  assert.ok(frames.every(frame => !('trades' in frame)), 'WebSockets carry no rows');
  const report = await (await fetch(s.url + done.download_url)).json();
  assert.equal(report.job_id, body.job_id); assert.equal(report.trades.length, 2000);
  assert.equal(s.app.store.job(body.job_id).imported, 2000);
  const repeat = await fetch(s.url + '/api/exchange-callback', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BSE-Signature': signature(s.secret, body.job_id) }, body: JSON.stringify({ jobId: body.job_id }) });
  assert.equal(repeat.status, 200); assert.equal((await repeat.json()).duplicate, true);
  assert.equal(s.app.store.trades().length, 2000);
});

test('reconnection replays completed download notification without transferring rows', async t => {
  const s = await system({ delayMs: 150, wsLifetimeMs: 40 }); t.after(() => s.close());
  const { job_id, websocket_url } = await (await fetch(s.url + '/api/pulls', { method: 'POST' })).json();
  const ws = new WebSocket(s.url.replace('http:', 'ws:') + websocket_url);
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  await waitSnapshot(ws, d => d.jobs[0]?.status === 'running'); assert.equal(await closed, 4000);
  await completionThroughRenewals(s, job_id);
  const renewed = new WebSocket(s.url.replace('http:', 'ws:') + websocket_url); t.after(() => renewed.terminate());
  const event = await waitJob(renewed, d => d.status === 'completed');
  assert.equal(event.job_id, job_id); assert.equal('trades' in event, false);
  assert.equal((await (await fetch(s.url + event.download_url)).json()).trades.length, 2000);
});

function completionThroughRenewals(s, id) {
  return new Promise((resolve, reject) => {
    let ws, done = false;
    const timeout = setTimeout(() => { done = true; ws.terminate(); reject(new Error('No completion notification')); }, 5000);
    function connect() {
      ws = new WebSocket(s.url.replace('http:', 'ws:') + `/live?job_id=${id}`);
      ws.on('message', raw => { const d = JSON.parse(raw.toString()); if (d.type === 'job' && d.status === 'completed') {
        done = true; clearTimeout(timeout); ws.terminate(); resolve(d);
      } });
      ws.on('close', () => { if (!done) connect(); }); ws.on('error', () => ws.close());
    }
    connect();
  });
}

test('restart retains a running job duration and its completed HTTP report', async t => {
  const s = await system({ delayMs: 350 }); t.after(() => s.close());
  const { job_id } = await (await fetch(s.url + '/api/pulls', { method: 'POST' })).json();
  await s.restartApp({ delayMs: 5000 });
  assert.equal(s.app.store.active().id, job_id); assert.equal(s.app.store.active().delayMs, 350);
  await completionThroughRenewals(s, job_id); await s.restartApp();
  assert.equal(s.app.store.trades().length, 2000); assert.equal(s.app.store.jobs().length, 1);
  const report = await (await fetch(s.url + `/api/pulls/${job_id}/trades`)).json();
  assert.equal(report.trades.length, 2000);
});

test('unsigned callbacks and cross-origin actions are rejected', async t => {
  const s = await system(); t.after(() => s.close());
  assert.equal((await fetch(s.url + '/api/exchange-callback', { method: 'POST', body: JSON.stringify({ jobId: 'bad' }) })).status, 401);
  assert.equal((await fetch(s.url + '/api/pulls', { method: 'POST', headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(s.url + '/api/exchange-callback', { method: 'POST', body: '{' })).status, 400);
  assert.equal(s.app.store.trades().length, 0);
});

test('unreachable exchange fails the job while retaining previous genuine imports', async t => {
  const app = await createApp({ port: 0, mockUrl: 'http://127.0.0.1:1', secret: 'secret' }); t.after(() => app.close());
  app.store.start('previous-import'); app.store.complete('previous-import', seededTrades(50, 3));
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/live`); t.after(() => ws.terminate());
  const failed = waitJob(ws, d => d.status === 'failed');
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/pulls`, { method: 'POST' })).status, 202);
  assert.match((await failed).error, /Could not pull/); assert.equal(app.store.trades().length, 3);
});

test('job deadline reports missing final completion without exposing partial data', async t => {
  const s = await system({ delayMs: 500, deadlineGraceMs: -400 }); t.after(() => s.close());
  const ws = new WebSocket(s.url.replace('http:', 'ws:') + '/live'); t.after(() => ws.terminate());
  const failed = waitJob(ws, d => d.status === 'failed');
  await fetch(s.url + '/api/pulls', { method: 'POST' });
  assert.match((await failed).error, /deadline/); assert.equal(s.app.store.trades().length, 0);
});

test('invalid report rolls back atomically; duplicate completion does not inflate counts', async t => {
  const s = await system(); t.after(() => s.close());
  s.app.store.start('transaction-test'); const records = seededTrades(55, 2);
  assert.throws(() => s.app.store.complete('transaction-test', [...records, { ...records[0], tradeId: 'invalid', quantity: null }]));
  assert.equal(s.app.store.trades().length, 0); assert.equal(s.app.store.jobTrades('transaction-test').length, 0);
  assert.equal(s.app.store.complete('transaction-test', records), 2);
  assert.equal(s.app.store.complete('transaction-test', records), 0); assert.equal(s.app.store.jobTrades('transaction-test').length, 2);
});
