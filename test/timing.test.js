import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createMock } from '../src/mock.js';
import { runtimeTiming, ASSESSMENT_PULL_MS, NETWORK_CONNECTION_LIMIT_MS } from '../src/timing.js';
import { system, waitSnapshot } from './helpers.js';

test('normal runtime uses the exact assessment limits and rejects shortened demo delays', () => {
  assert.deepEqual(runtimeTiming({}), { delayMs: 900000, connectionLimitMs: 30000, wsLifetimeMs: 25000 });
  assert.throws(() => runtimeTiming({ PULL_DELAY_MS: '12000' }), /900000/);
  assert.throws(() => runtimeTiming({ PULL_DELAY_MS: '32000' }), /900000/);
  assert.equal(runtimeTiming({ PULL_DELAY_MS: '960000' }).delayMs, 960000);
  // Environment variables cannot silently weaken the problem's network limit.
  assert.equal(runtimeTiming({ NETWORK_TIMEOUT_MS: '999999', WS_LIFETIME_MS: '999999' }).connectionLimitMs, 30000);
});

test('default mock persists a readiness time a full 15 minutes after acceptance', async t => {
  const mock = await createMock({ port: 0, secret: 'test' }); t.after(() => mock.close());
  const before = Date.now();
  const response = await fetch(`http://127.0.0.1:${mock.port}/getTrades?mode=async&jobId=full-duration-test`);
  const body = await response.json(); const after = Date.now();
  assert.equal(response.status, 202);
  assert.equal(body.delayMs, ASSESSMENT_PULL_MS);
  assert.ok(Date.parse(body.readyAt) >= before + ASSESSMENT_PULL_MS);
  assert.ok(Date.parse(body.readyAt) <= after + ASSESSMENT_PULL_MS);
  const health = await (await fetch(`http://127.0.0.1:${mock.port}/health`)).json();
  assert.equal(health.connectionLimitMs, NETWORK_CONNECTION_LIMIT_MS);
  const stillPending = await fetch(`http://127.0.0.1:${mock.port}/getTrades?mode=async&jobId=full-duration-test`);
  assert.equal(stillPending.status, 202);
});

test('normal startup extends an unfinished legacy short demo job to the assessment minimum', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tradeflow-legacy-'));
  const dbPath = join(dir, 'exchange.sqlite');
  let mock = await createMock({ port: 0, dbPath, delayMs: 12000, secret: 'test' });
  t.after(async () => { await mock.close(); await rm(dir, { recursive: true, force: true }); });
  const before = Date.now();
  const job = await (await fetch(`http://127.0.0.1:${mock.port}/getTrades?mode=async&jobId=legacy-demo`)).json();
  assert.equal(job.delayMs, 12000);
  await mock.close();
  mock = await createMock({ port: 0, dbPath, minimumPendingDelayMs: ASSESSMENT_PULL_MS, secret: 'test' });
  const response = await fetch(`http://127.0.0.1:${mock.port}/getTrades?mode=async&jobId=legacy-demo`);
  const upgraded = await response.json();
  assert.equal(response.status, 202);
  assert.equal(upgraded.delayMs, 900000);
  assert.ok(Date.parse(upgraded.readyAt) >= before + 900000);
});

test('slow synchronous GET is cut off by the actual network while async work survives', async t => {
  // Reduced factory timings isolate the mechanism; npm run test:assessment checks
  // the unmodified 900-second/30-second constraints against real wall time.
  const s = await system({ delayMs: 650, connectionLimitMs: 220, wsLifetimeMs: 100 }); t.after(() => s.close());
  let ws, stopping = false, resolveCompleted, rejectCompleted;
  const completed = new Promise((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
  function connect() {
    ws = new WebSocket(s.url.replace('http:', 'ws:') + '/live');
    ws.on('message', raw => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'snapshot' && data.jobs[0]?.status === 'completed') { stopping = true; resolveCompleted(data); }
    });
    ws.on('close', () => { if (!stopping) connect(); });
    ws.on('error', error => rejectCompleted(error));
  }
  t.after(() => { stopping = true; ws?.terminate(); });
  connect();
  await fetch(s.url + '/api/pulls', { method: 'POST' });
  const began = performance.now();
  const error = await new Promise(resolve => {
    const request = http.get(s.url + '/api/direct-pull', { agent: false }, res => { res.resume(); resolve(new Error(`Unexpected HTTP ${res.statusCode}`)); });
    request.once('error', resolve);
  });
  assert.equal(error.code, 'ECONNRESET');
  assert.ok(performance.now() - began >= 210);
  assert.equal(s.app.store.active().status, 'running');
  const snapshot = await completed;
  assert.equal(s.app.store.trades().length, 2000);
  assert.equal('trades' in snapshot, false);
  assert.ok(snapshot.networkTimeouts.some(e => e.path === '/api/direct-pull' && e.elapsedMs >= 210));
});

test('hard network lifetime also kills an upgraded socket if it is not renewed', async t => {
  const s = await system({ connectionLimitMs: 250, wsLifetimeMs: 1000 }); t.after(() => s.close());
  const ws = new WebSocket(s.url.replace('http:', 'ws:') + '/live'); t.after(() => ws.terminate());
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  await waitSnapshot(ws, d => d.jobs.length === 0);
  assert.equal(await closed, 1006, 'Network must reset the socket, not simulate a graceful renewal');
  const snapshot = await (await fetch(s.url + '/api/trades')).json();
  assert.ok(snapshot.networkTimeouts.some(e => e.kind === 'WebSocket' && e.path === '/live'));
});
