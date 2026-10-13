import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { openStore } from './store.js';
import { json, readJson, verifySignature } from './common.js';
import { ASSESSMENT_PULL_MS, NETWORK_CONNECTION_LIMIT_MS, LIVE_RENEWAL_MS, TRADES_PER_PULL, TRADES_PER_BATCH, enforceConnectionLimit } from './timing.js';

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
  const snapshot = () => ({ type: 'snapshot', trades: store.trades(), jobs: store.jobs(), delayMs,
    connectionLimitMs, wsLifetimeMs, totalTrades: TRADES_PER_PULL, batchSize: TRADES_PER_BATCH, networkTimeouts, serverTime: Date.now() });
  function broadcast() {
    const data = JSON.stringify(snapshot());
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
  }
  async function dispatch(id) {
    try {
      const response = await fetch(`${mockUrl}/getTrades?mode=async&jobId=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(connectionLimitMs) });
      if (![200, 202].includes(response.status)) throw new Error(`Exchange returned ${response.status}`);
      const data = await response.json();
      if (data.jobId !== id) throw new Error('Exchange job ID mismatch');
      if (stopping) return;
      if (!Number.isFinite(Date.parse(data.readyAt)) || !Number.isSafeInteger(data.delayMs) || data.delayMs < 0) throw new Error('Invalid exchange readiness metadata');
      store.setReadiness(id, data.readyAt, data.delayMs);
      clearTimeout(deadlines.get(id));
      if (response.status === 200) importBatch(id, data);
      if (store.job(id).status === 'running') armDeadline(store.job(id));
      broadcast();
    } catch (error) { fail(id, `Could not pull from exchange: ${error.message}`); }
  }
  function importBatch(id, data) {
    const trades = validateTrades(data.trades);
    if (typeof data.complete !== 'boolean' || data.available !== trades.length || data.totalTrades !== TRADES_PER_PULL ||
      (data.complete && trades.length !== TRADES_PER_PULL)) throw new Error('Invalid progressive batch metadata');
    const imported = store.applyBatch(id, trades, data.complete);
    if (data.complete) { clearTimeout(deadlines.get(id)); deadlines.delete(id); }
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
        if (active) return json(res, 202, { job: active, alreadyRunning: true });
        const id = randomUUID();
        store.start(id, delayMs);
        const job = store.job(id);
        armDeadline(job);
        json(res, 202, { job, alreadyRunning: false });
        broadcast();
        void dispatch(id);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/exchange-callback') {
        const { jobId } = await readJson(req);
        if (!verifySignature(secret, jobId, req.headers['x-bse-signature'])) return json(res, 401, { error: 'Invalid callback signature' });
        const job = store.job(jobId);
        if (!job) return json(res, 404, { error: 'Unknown job' });
        if (job.status === 'completed') return json(res, 200, { accepted: true, duplicate: true, receivedCount: TRADES_PER_PULL });
        if (job.status !== 'running') return json(res, 409, { error: 'Job is no longer running' });
        const response = await fetch(`${mockUrl}/getTrades?mode=async&jobId=${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(connectionLimitMs) });
        if (response.status !== 200) return json(res, 503, { error: 'Exchange batch is not ready' });
        const batch = await response.json();
        if (batch.jobId !== jobId) throw new Error('Exchange job ID mismatch');
        if (stopping) return json(res, 503, { error: 'Shutting down' });
        const imported = importBatch(jobId, batch);
        broadcast();
        return json(res, 200, { accepted: true, imported, receivedCount: batch.available });
      }
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, contentType] = files[url.pathname];
        const data = await readFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)));
        res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'" });
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
    if (req.url !== '/live' || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    // A fresh authoritative snapshot closes any reconnect/completion race.
    ws.send(JSON.stringify(snapshot()));
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
  return { server, store, port: server.address().port, close: async () => {
    stopping = true;
    for (const deadline of deadlines.values()) clearTimeout(deadline);
    for (const upstream of upstreamRequests) upstream.destroy();
    for (const ws of wss.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    store.close();
  } };
}
