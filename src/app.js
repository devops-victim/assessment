import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { openStore } from './store.js';
import { json, readJson, verifySignature } from './common.js';
import { ASSESSMENT_PULL_MS, NETWORK_CONNECTION_LIMIT_MS, LIVE_RENEWAL_MS, TRADES_PER_PULL, enforceConnectionLimit } from './timing.js';

function validateTrades(value) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid trade batch');
  const ids = new Set();
  for (const t of value) {
    if (!t || typeof t.tradeId !== 'string' || t.tradeId.length > 80 || ids.has(t.tradeId) ||
      typeof t.client !== 'string' || !t.client || typeof t.symbol !== 'string' || !t.symbol ||
      !Number.isSafeInteger(t.quantity) || t.quantity <= 0 || !Number.isFinite(t.price) || t.price <= 0 ||
      typeof t.timestamp !== 'string' || !Number.isFinite(Date.parse(t.timestamp))) throw new Error('Invalid trade record');
    ids.add(t.tradeId);
  }
  return value;
}

export async function createApp({ port = 3000, dbPath = ':memory:', mockUrl, secret, delayMs = ASSESSMENT_PULL_MS, connectionLimitMs = NETWORK_CONNECTION_LIMIT_MS, wsLifetimeMs = LIVE_RENEWAL_MS, deadlineGraceMs = 120000 }) {
  const store = openStore(dbPath);
  const deadlines = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  let stopping = false;
  const networkTimeouts = [];
  const upstreamRequests = new Set();
  const state = () => ({
    type: 'snapshot', jobs: store.jobs().map(job => ({
      ...job,
      ...(job.status === 'completed' ? { download_url: `/api/pulls/${encodeURIComponent(job.id)}/trades` } : {})
    })), delayMs,
    connectionLimitMs, wsLifetimeMs, totalTrades: TRADES_PER_PULL, networkTimeouts, serverTime: Date.now()
  });
  const snapshot = () => ({ ...state(), trades: store.trades() });
  const jobEvent = job => ({
    type: 'job', job_id: job.id, status: job.status === 'running' ? 'processing' : job.status,
    ...(job.status === 'completed' ? { download_url: `/api/pulls/${encodeURIComponent(job.id)}/trades`, imported: job.imported } : {}),
    ...(job.error ? { error: job.error } : {})
  });
  function notifyJob(id) {
    const event = JSON.stringify(jobEvent(store.job(id)));
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN && (!ws.jobId || ws.jobId === id)) ws.send(event);
  }
  function broadcast() {
    // WebSockets carry only job/connection metadata. Rows use HTTP downloads.
    const data = JSON.stringify(state());
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 2 * 1024 * 1024) ws.terminate();
        else ws.send(data);
      }
    }
  }
  function fail(id, reason) {
    if (stopping) return;
    store.fail(id, reason);
    clearTimeout(deadlines.get(id)); deadlines.delete(id);
    broadcast();
    notifyJob(id);
  }
  async function dispatch(id) {
    try {
      const response = await fetch(`${mockUrl}/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: id }), signal: AbortSignal.timeout(connectionLimitMs)
      });
      if (![200, 202].includes(response.status)) throw new Error(`Exchange returned ${response.status}`);
      const data = await response.json();
      if (data.jobId !== id) throw new Error('Exchange job ID mismatch');
      if (stopping) return;
      if (!Number.isFinite(Date.parse(data.readyAt)) || !Number.isSafeInteger(data.delayMs) || data.delayMs < 0) throw new Error('Invalid exchange readiness metadata');
      store.setReadiness(id, data.readyAt, data.delayMs);
      clearTimeout(deadlines.get(id));
      if (response.status === 200) await retrieveReadyJob(id);
      if (store.job(id).status === 'running') armDeadline(store.job(id));
      broadcast();
    } catch (error) { fail(id, `Could not pull from exchange: ${error.message}`); }
  }
  async function retrieveReadyJob(id) {
    const response = await fetch(`${mockUrl}/getTrades?jobId=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(connectionLimitMs) });
    if (response.status !== 200) throw new Error('Exchange report is not ready');
    const data = await response.json();
    if (stopping) throw new Error('Shutting down');
    if (data.jobId !== id || data.status !== 'completed') throw new Error('Invalid completed report metadata');
    const trades = validateTrades(data.trades);
    if (trades.length !== TRADES_PER_PULL) throw new Error('Incomplete trade report');
    const imported = store.complete(id, trades);
    clearTimeout(deadlines.get(id)); deadlines.delete(id);
    broadcast(); notifyJob(id);
    return imported;
  }
  function armDeadline(job) {
    const expectedReadyAt = job.readyAt ? Date.parse(job.readyAt) : Date.parse(job.startedAt) + job.delayMs;
    const remaining = expectedReadyAt + deadlineGraceMs - Date.now();
    deadlines.set(job.id, setTimeout(() => fail(job.id, 'Exchange did not deliver before the job deadline. Start a new pull.'), Math.max(0, remaining)));
  }
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/assessment.css': ['assessment.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/api/trades') return json(res, 200, snapshot());
      const download = /^\/api\/pulls\/([\w-]{1,80})\/trades$/.exec(url.pathname);
      if (req.method === 'GET' && download) {
        const job = store.job(download[1]);
        if (!job) return json(res, 404, { error: 'Unknown job' });
        if (job.status !== 'completed') return json(res, 409, { job_id: job.id, status: job.status, error: 'Report is not ready' });
        return json(res, 200, { job_id: job.id, trades: store.jobTrades(job.id), completed_at: job.completedAt });
      }
      if (req.method === 'GET' && url.pathname === '/api/direct-pull') {
        // Reproduce the original slow synchronous request, through the same
        // hard-limited network as the working asynchronous import.
        const upstream = http.get(`${mockUrl}/getTrades`, { agent: false }, exchange => {
          if (res.destroyed) return exchange.destroy();
          res.writeHead(exchange.statusCode, exchange.headers);
          exchange.pipe(res);
        });
        upstreamRequests.add(upstream);
        upstream.on('error', () => {
          // An actual socket reset is surfaced, never a fabricated timeout JSON.
          res.destroy();
        });
        upstream.once('close', () => upstreamRequests.delete(upstream));
        res.once('close', () => upstream.destroy());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pulls') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Invalid origin' });
        const active = store.active();
        if (active) return json(res, 202, { job_id: active.id, websocket_url: `/live?job_id=${active.id}`, job: active, alreadyRunning: true });
        const id = randomUUID();
        store.start(id, delayMs);
        const job = store.job(id);
        armDeadline(job);
        json(res, 202, { job_id: id, websocket_url: `/live?job_id=${id}`, job, alreadyRunning: false });
        broadcast();
        notifyJob(id);
        void dispatch(id);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/exchange-callback') {
        const { jobId } = await readJson(req);
        if (!verifySignature(secret, jobId, req.headers['x-bse-signature'])) return json(res, 401, { error: 'Invalid callback signature' });
        const job = store.job(jobId);
        if (!job) return json(res, 404, { error: 'Unknown job' });
        if (job.status === 'completed') return json(res, 200, { accepted: true, duplicate: true });
        if (job.status !== 'running') return json(res, 409, { error: 'Job is no longer running' });
        const imported = await retrieveReadyJob(jobId);
        return json(res, 200, { accepted: true, imported });
      }
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, contentType] = files[url.pathname];
        const data = await readFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)));
        res.writeHead(200, {
          'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'"
        });
        return res.end(data);
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, error instanceof SyntaxError || error.message === 'Request body too large' ? 400 : 502, { error: error.message });
    }
  });
  enforceConnectionLimit(server, connectionLimitMs, event => {
    if (stopping) return;
    networkTimeouts.unshift({ ...event, id: randomUUID() });
    networkTimeouts.splice(8);
    console.log(`[network] ${event.kind} ${event.path}: socket killed after ${event.elapsedMs}ms (limit ${connectionLimitMs}ms)`);
    broadcast();
  });
  server.requestTimeout = connectionLimitMs;
  server.headersTimeout = connectionLimitMs;
  server.keepAliveTimeout = 1000;
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const jobId = url.searchParams.get('job_id');
    if (url.pathname !== '/live' || (jobId && !store.job(jobId)) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => { ws.jobId = jobId; wss.emit('connection', ws); });
  });
  wss.on('connection', ws => {
    // Reconnection replays durable completion notifications, without rows.
    ws.send(JSON.stringify(state()));
    if (ws.jobId) ws.send(JSON.stringify(jobEvent(store.job(ws.jobId))));
    else for (const job of store.jobs()) if (job.status === 'completed') ws.send(JSON.stringify(jobEvent(job)));
    const lifetime = setTimeout(() => {
      ws.close(4000, 'Renew connection before network cutoff');
      const force = setTimeout(() => ws.terminate(), 500);
      ws.once('close', () => clearTimeout(force));
    }, wsLifetimeMs);
    ws.on('error', () => ws.terminate());
    ws.once('close', () => clearTimeout(lifetime));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const active = store.active();
  if (active) { armDeadline(active); void dispatch(active.id); }
  return {
    server, store, port: server.address().port, close: async () => {
      stopping = true;
      for (const deadline of deadlines.values()) clearTimeout(deadline);
      for (const upstream of upstreamRequests) upstream.destroy();
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      store.close();
    }
  };
}
