import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { seededTrades } from '../src/common.js';
import { system, waitJob } from './helpers.js';

test('completed HTTP downloads contain only their own job and job events respect subscriptions', async t => {
  const s = await system({ delayMs: 350 }); t.after(() => s.close());
  s.app.store.start('older-job'); s.app.store.complete('older-job', seededTrades(99, 3));
  const older = new WebSocket(s.url.replace('http:', 'ws:') + '/live?job_id=older-job'); t.after(() => older.terminate());
  await waitJob(older, d => d.status === 'completed');
  const seen = []; older.on('message', raw => { const d = JSON.parse(raw.toString()); if (d.type === 'job') seen.push(d); });
  const { job_id, websocket_url } = await (await fetch(s.url + '/api/pulls', { method: 'POST' })).json();
  const fresh = new WebSocket(s.url.replace('http:', 'ws:') + websocket_url); t.after(() => fresh.terminate());
  const completed = await waitJob(fresh, d => d.status === 'completed');
  assert.equal(completed.job_id, job_id); assert.equal(seen.length, 0, 'Other jobs do not notify this job-specific channel');
  assert.equal((await (await fetch(s.url + completed.download_url)).json()).trades.length, 2000);
  assert.equal((await (await fetch(s.url + '/api/pulls/older-job/trades')).json()).trades.length, 3);
  assert.equal(s.app.store.trades().length, 2003);
});

test('exchange restart retains the original completion deadline without publishing processing rows', async t => {
  const s = await system({ delayMs: 600 }); t.after(() => s.close());
  const { job_id, websocket_url } = await (await fetch(s.url + '/api/pulls', { method: 'POST' })).json();
  const ws = new WebSocket(s.url.replace('http:', 'ws:') + websocket_url); t.after(() => ws.terminate());
  const completed = waitJob(ws, d => d.status === 'completed');
  const before = await (await fetch(`http://127.0.0.1:${s.mock.port}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id }) })).json();
  await s.restartMock();
  const after = await (await fetch(`http://127.0.0.1:${s.mock.port}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id }) })).json();
  assert.equal(after.readyAt, before.readyAt); assert.equal(s.app.store.trades().length, 0);
  assert.equal((await completed).status, 'completed'); assert.equal(s.app.store.trades().length, 2000);
});
