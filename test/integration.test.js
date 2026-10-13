import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { seededTrades, signature, integerEnv } from '../src/common.js';
import { system, waitSnapshot } from './helpers.js';

test('seeded trade records are deterministic and contain valid required fields', () => {
  const records = seededTrades(0, 3000);
  assert.equal(records.length, 3000);
  assert.deepEqual(records, seededTrades(0, 3000));
  assert.equal(new Set(records.map(t => t.tradeId)).size, 3000);
  assert.ok(records.every(t => t.quantity > 0 && t.price > 0 && t.client && t.symbol && Number.isFinite(Date.parse(t.timestamp))));
  assert.equal(integerEnv(undefined, 900000, 'delay'), 900000);
  assert.throws(() => integerEnv('-1', 0, 'delay', 0));
});

test('pull returns immediately, saved trades stay available, and completion is pushed to two open clients', async t => {
  const s = await system({ delayMs: 800 }); t.after(() => s.close());
  const a = new WebSocket(s.url.replace('http:', 'ws:') + '/live');
  const b = new WebSocket(s.url.replace('http:', 'ws:') + '/live');
  t.after(() => { a.terminate(); b.terminate(); });
  await Promise.all([waitSnapshot(a, d => d.trades.length === 0), waitSnapshot(b, d => d.trades.length === 0)]);
  const partial = Promise.all([waitSnapshot(a, d => d.trades.length > 0 && d.trades.length < 2000), waitSnapshot(b, d => d.trades.length > 0 && d.trades.length < 2000)]);
  const updates = Promise.all([waitSnapshot(a, d => d.jobs[0]?.status === 'completed'), waitSnapshot(b, d => d.jobs[0]?.status === 'completed')]);
  const started = performance.now();
  const result = await fetch(s.url + '/api/pulls', { method: 'POST' });
  assert.equal(result.status, 202);
  assert.ok(performance.now() - started < 500, 'request must not wait for exchange completion');
  const { job } = await result.json();
  const saved = await (await fetch(s.url + '/api/trades')).json();
  assert.ok(saved.trades.length < 2000);
  assert.equal(saved.jobs[0].status, 'running');
  const duplicate = await (await fetch(s.url + '/api/pulls', { method: 'POST' })).json();
  assert.equal(duplicate.job.id, job.id); assert.equal(duplicate.alreadyRunning, true);
  const chunks = await partial;
  assert.ok(chunks.every(d => d.jobs[0].status === 'running' && d.jobs[0].imported === d.trades.length));
  const [first, second] = await updates;
  assert.equal(first.jobs[0].imported, 2000); assert.equal(second.jobs[0].status, 'completed');
  const repeat = await fetch(s.url + '/api/exchange-callback', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BSE-Signature': signature(s.secret, job.id) }, body: JSON.stringify({ jobId: job.id }) });
  assert.equal(repeat.status, 200); assert.equal((await repeat.json()).duplicate, true);
  assert.equal(s.app.store.trades().length, 2000);
  const exchange = await fetch(`http://127.0.0.1:${s.mock.port}/getTrades?jobId=${job.id}`);
  assert.equal(exchange.status, 200); assert.equal((await exchange.json()).trades.length, 2000);
});

test('a renewed WebSocket receives an authoritative snapshot after missing completion', async t => {
  const s = await system({ delayMs: 70, wsLifetimeMs: 40 }); t.after(() => s.close());
  const ws = new WebSocket(s.url.replace('http:', 'ws:') + '/live');
  await waitSnapshot(ws, d => d.trades.length === 0);
  const close = new Promise(resolve => ws.once('close', (code) => resolve(code)));
  assert.equal(await close, 4000);
  const callback = waitForComplete(s);
  await fetch(s.url + '/api/pulls', { method: 'POST' });
  await callback;
  const renewed = new WebSocket(s.url.replace('http:', 'ws:') + '/live'); t.after(() => renewed.terminate());
  const snapshot = await waitSnapshot(renewed, d => d.trades.length === 2000);
  assert.equal(snapshot.jobs[0].status, 'completed');
});

function waitForComplete(s) {
  return new Promise((resolve, reject) => {
    let ws, done = false;
    const timeout = setTimeout(() => { done = true; ws.terminate(); reject(new Error('No completion push')); }, 5000);
    function connect() {
      ws = new WebSocket(s.url.replace('http:', 'ws:') + '/live');
      ws.on('message', raw => {
        const data = JSON.parse(raw.toString());
        if (data.jobs[0]?.status === 'completed') {
          done = true; clearTimeout(timeout); ws.terminate(); resolve(data);
        }
      });
      ws.on('close', () => { if (!done) connect(); });
      ws.on('error', () => ws.close());
    }
    connect();
  });
}

test('restart preserves trades and resumes an unfinished import with the same job ID', async t => {
  const s = await system({ delayMs: 350 }); t.after(() => s.close());
  const { job } = await (await fetch(s.url + '/api/pulls', { method: 'POST' })).json();
  await s.restartApp({ delayMs: 5000 });
  assert.equal(s.app.store.active().id, job.id);
  assert.equal(s.app.store.active().delayMs, 350, 'An existing job keeps its actual duration when runtime configuration changes');
  await waitForComplete(s);
  assert.equal(s.app.store.trades().length, 2000);
  await s.restartApp();
  assert.equal(s.app.store.trades().length, 2000);
  assert.equal(s.app.store.jobs().length, 1);
});

test('unsigned callbacks and cross-origin actions are rejected', async t => {
  const s = await system(); t.after(() => s.close());
  const fake = await fetch(s.url + '/api/exchange-callback', { method: 'POST', body: JSON.stringify({ jobId: 'bad' }) });
  assert.equal(fake.status, 401);
  const origin = await fetch(s.url + '/api/pulls', { method: 'POST', headers: { Origin: 'http://evil.example' } });
  assert.equal(origin.status, 403);
  const invalid = await fetch(s.url + '/api/exchange-callback', { method: 'POST', body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal(s.app.store.trades().length, 0);
});

test('unreachable exchange marks the job failed without deleting cached trades', async t => {
  const app = await createApp({ port: 0, mockUrl: 'http://127.0.0.1:1', secret: 'secret' }); t.after(() => app.close());
  app.store.start('previous-import'); app.store.complete('previous-import', seededTrades(50, 3));
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/live`); t.after(() => ws.terminate());
  const failed = waitSnapshot(ws, d => d.jobs[0]?.status === 'failed');
  const response = await fetch(`http://127.0.0.1:${app.port}/api/pulls`, { method: 'POST' });
  assert.equal(response.status, 202);
  const data = await failed;
  assert.equal(data.trades.length, 3); assert.match(data.jobs[0].error, /Could not pull/);
});

test('an incomplete pull is bounded by the job deadline and keeps received batches', async t => {
  const s = await system({ delayMs: 500, deadlineGraceMs: -400 }); t.after(() => s.close());
  const ws = new WebSocket(s.url.replace('http:', 'ws:') + '/live'); t.after(() => ws.terminate());
  const failed = waitSnapshot(ws, d => d.jobs[0]?.status === 'failed');
  await fetch(s.url + '/api/pulls', { method: 'POST' });
  const data = await failed;
  assert.match(data.jobs[0].error, /deadline/); assert.ok(data.trades.length < 2000);
  assert.equal(data.jobs[0].imported, data.trades.length);
});

test('an invalid batch rolls back the entire transaction; IDs are deduplicated', async t => {
  const s = await system(); t.after(() => s.close());
  const id = 'transaction-test'; s.app.store.start(id);
  const valid = seededTrades(55, 2);
  assert.throws(() => s.app.store.complete(id, [...valid, { ...valid[0], tradeId: 'invalid', quantity: null }]));
  assert.equal(s.app.store.trades().length, 0); assert.equal(s.app.store.job(id).status, 'running');
  assert.equal(s.app.store.complete(id, valid), 2);
  assert.equal(s.app.store.complete(id, valid), 0);
  assert.equal(s.app.store.trades().length, 2);
});
