import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { system } from '../test/helpers.js';
import { ASSESSMENT_PULL_MS, NETWORK_CONNECTION_LIMIT_MS, LIVE_RENEWAL_MS } from '../src/timing.js';

// Real wall-clock assessment run. No duration override and no mocked timers.
await mkdir('artifacts', { recursive: true });
const s = await system({ delayMs: ASSESSMENT_PULL_MS, connectionLimitMs: NETWORK_CONNECTION_LIMIT_MS, wsLifetimeMs: LIVE_RENEWAL_MS });
const origin = performance.now();
const events = [];
const record = (label, detail) => {
  const event = { seconds: (performance.now() - origin) / 1000, label, detail };
  events.push(event); console.log(`${event.seconds.toFixed(2)}s  ${label}  ${detail}`);
};
let socket, stopping = false, connectionCount = 0, startedAt, completedElapsedMs;
let firstBatchElapsedMs, partialSnapshots = 0;
let resolveInitial, resolveComplete, rejectComplete, directRequest;
const initial = new Promise(resolve => { resolveInitial = resolve; });
const complete = new Promise((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
const deadline = setTimeout(() => rejectComplete(new Error('Full 15-minute assessment run timed out')), ASSESSMENT_PULL_MS + 60000);
function connect() {
  socket = new WebSocket(s.url.replace('http:', 'ws:') + '/live');
  socket.on('open', () => record('WebSocket connected', `Connection ${++connectionCount}: renewal before the 30s cap`));
  socket.on('message', raw => {
    const snapshot = JSON.parse(raw.toString());
    if (snapshot.type !== 'snapshot') return;
    record('Snapshot pushed', `${snapshot.trades.length.toLocaleString('en-US')} saved trades; job ${snapshot.jobs[0]?.status || 'not started'}`);
    if (snapshot.trades.length > 0 && snapshot.jobs[0]?.status === 'running') {
      partialSnapshots++;
      firstBatchElapsedMs ??= performance.now() - startedAt;
    }
    resolveInitial();
    if (snapshot.jobs[0]?.status === 'completed') {
      completedElapsedMs = performance.now() - startedAt;
      record('Full pull completed', `${(completedElapsedMs / 1000).toFixed(2)}s elapsed; 2,000 trades committed and pushed`);
      resolveComplete();
    }
  });
  socket.on('close', code => {
    if (stopping) return;
    record('WebSocket renewed', `Code ${code}; no data/status HTTP polling`);
    connect();
  });
  socket.on('error', error => { if (!stopping) rejectComplete(error); });
}
try {
  connect();
  await initial;
  startedAt = performance.now();
  const response = await fetch(s.url + '/api/pulls', { method: 'POST' });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  record('POST /api/pulls -> 202', `Accepted in ${(performance.now() - startedAt).toFixed(0)}ms; work duration 900s`);
  const saved = await (await fetch(s.url + '/api/trades')).json();
  assert.equal(saved.trades.length, 0); assert.equal(saved.jobs[0].status, 'running');
  record('Initially empty dashboard', '0 trades; real batches will arrive during the 15-minute pull');
  const direct = new Promise((resolve, reject) => {
    const began = performance.now();
    record('Synchronous GET started', '/getTrades needs 900s; this connection has a 30s lifetime');
    directRequest = http.get(s.url + '/api/direct-pull', { agent: false }, res => {
      res.resume(); reject(new Error(`Synchronous request unexpectedly returned HTTP ${res.statusCode}`));
    });
    directRequest.once('error', error => {
      const elapsed = performance.now() - began;
      try {
        assert.ok(elapsed >= 29500 && elapsed < 33000, `Expected actual 30s socket reset, got ${elapsed}ms`);
        record('30s connection killed', `Actual ${error.code}; elapsed ${(elapsed / 1000).toFixed(2)}s; background pull continues`);
        resolve(elapsed);
      } catch (failure) { reject(failure); }
    });
  });
  const [directElapsedMs] = await Promise.all([direct, complete]);
  assert.ok(completedElapsedMs >= ASSESSMENT_PULL_MS, 'No import before the full 15-minute delay');
  assert.ok(connectionCount >= 36, 'Push subscription must renew across the entire pull');
  assert.equal(s.app.store.trades().length, 2000);
  assert.ok(partialSnapshots > 0, 'Trades must be pushed while the job is still running');
  assert.ok(firstBatchElapsedMs >= 45000 && firstBatchElapsedMs < 60000, 'First real batch is due after 45 seconds');
  assert.equal(s.app.store.job(job.id).status, 'completed');
  const capture = { delayMs: ASSESSMENT_PULL_MS, connectionLimitMs: NETWORK_CONNECTION_LIMIT_MS,
    completedElapsedMs, directElapsedMs, connectionCount, firstBatchElapsedMs, partialSnapshots, initialTradeCount: 0, events };
  await writeFile('artifacts/walkthrough-events.json', JSON.stringify(capture, null, 2));
  console.log('PASS: real 15-minute pull, real 30-second disconnect, saved reads and push completion.');
} finally {
  stopping = true; clearTimeout(deadline); directRequest?.destroy(); socket?.terminate(); await s.close();
}
