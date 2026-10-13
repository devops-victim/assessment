import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { system } from '../test/helpers.js';
import { ASSESSMENT_PULL_MS, NETWORK_CONNECTION_LIMIT_MS, LIVE_RENEWAL_MS } from '../src/timing.js';

await mkdir('artifacts', { recursive: true });
const s = await system({ initialTradeCount: 300, delayMs: ASSESSMENT_PULL_MS, connectionLimitMs: NETWORK_CONNECTION_LIMIT_MS, wsLifetimeMs: LIVE_RENEWAL_MS });
const origin = performance.now(), events = [];
function record(label, detail) {
  const event = { seconds: (performance.now() - origin) / 1000, label, detail };
  events.push(event); console.log(`${event.seconds.toFixed(2)}s  ${label}  ${detail}`);
}
let ws, directRequest, stopping = false, downloading = false, jobId, websocketUrl, startedAt, completedElapsedMs, downloadElapsedMs, connectionCount = 0;
let resolveComplete, rejectComplete;
const complete = new Promise((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
const deadline = setTimeout(() => rejectComplete(new Error('Full assessment run timed out')), ASSESSMENT_PULL_MS + 60000);
function connect() {
  ws = new WebSocket(s.url.replace('http:', 'ws:') + websocketUrl);
  ws.on('open', () => record('Job WebSocket connected', `Job ${jobId.slice(0, 8)}; connection ${++connectionCount}`));
  ws.on('message', raw => {
    const event = JSON.parse(raw.toString());
    assert.equal('trades' in event, false, 'No report data may be sent over WebSocket');
    if (event.type === 'snapshot') {
      const job = event.jobs.find(j => j.id === jobId);
      if (job?.status === 'running') assert.equal(s.app.store.trades().length, 300, 'Historical trades remain visible before report completion');
      record('Subscription state', `Job ${job?.status}; notification metadata only`);
    }
    if (event.type === 'job' && event.status === 'completed' && !downloading) {
      downloading = true; completedElapsedMs = performance.now() - startedAt;
      record('Completed notification', `status=completed; download_url=${event.download_url}`);
      void (async () => {
        const began = performance.now();
        const response = await fetch(s.url + event.download_url);
        assert.equal(response.status, 200);
        const report = await response.json(); downloadElapsedMs = performance.now() - began;
        assert.equal(report.job_id, jobId); assert.equal(report.trades.length, 2000);
        record('HTTP report downloaded', `2,000 trades in ${downloadElapsedMs.toFixed(0)}ms; dashboard can render now`);
        resolveComplete();
      })().catch(rejectComplete);
    }
  });
  ws.on('close', code => { if (!stopping) { record('Subscription renewed', `Code ${code}; same durable job, no HTTP polling`); connect(); } });
  ws.on('error', error => { if (!stopping) rejectComplete(error); });
}
try {
  const initial = await (await fetch(s.url + '/api/trades')).json();
  assert.equal(initial.trades.length, 300); record('Initial HTTP cache read', '300 historical trades; new report will be appended');
  startedAt = performance.now();
  const trigger = await fetch(s.url + '/api/pulls', { method: 'POST' });
  assert.equal(trigger.status, 202);
  const accepted = await trigger.json(); jobId = accepted.job_id; websocketUrl = accepted.websocket_url;
  assert.ok(performance.now() - startedAt < 1000);
  record('POST -> 202 Accepted', `job_id=${jobId}; accepted in ${(performance.now() - startedAt).toFixed(0)}ms`);
  connect();
  const direct = new Promise((resolve, reject) => {
    const began = performance.now(); record('Synchronous GET started', '15-minute response cannot survive a 30-second connection');
    directRequest = http.get(s.url + '/api/direct-pull', { agent: false }, res => { res.resume(); reject(new Error('Direct GET unexpectedly completed')); });
    directRequest.once('error', error => {
      const elapsed = performance.now() - began;
      if (error.code !== 'ECONNRESET' || elapsed < 29500 || elapsed > 33000) return reject(error);
      record('30s connection killed', `Actual ECONNRESET after ${(elapsed / 1000).toFixed(2)}s; job still processing`); resolve(elapsed);
    });
  });
  const [directElapsedMs] = await Promise.all([direct, complete]);
  assert.ok(completedElapsedMs >= ASSESSMENT_PULL_MS); assert.ok(connectionCount >= 36);
  assert.equal(s.app.store.job(jobId).status, 'completed'); assert.equal(s.app.store.trades().length, 2300);
  await writeFile('artifacts/walkthrough-events.json', JSON.stringify({ approach: 'B', delayMs: ASSESSMENT_PULL_MS,
    connectionLimitMs: NETWORK_CONNECTION_LIMIT_MS, completedElapsedMs, downloadElapsedMs, directElapsedMs, connectionCount, initialTradeCount: 300, events }, null, 2));
  console.log('PASS: Approach B, actual 15-minute processing, small WS notification, HTTP download, actual 30-second reset.');
} finally { stopping = true; clearTimeout(deadline); directRequest?.destroy(); ws?.terminate(); await s.close(); }
