import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { json, seededTrades, signature } from './common.js';
import { ASSESSMENT_PULL_MS, NETWORK_CONNECTION_LIMIT_MS, TRADES_PER_PULL, TRADES_PER_BATCH, enforceConnectionLimit } from './timing.js';

export async function createMock({ port = 4100, dbPath = ':memory:', delayMs = ASSESSMENT_PULL_MS, minimumPendingDelayMs = 0,
  connectionLimitMs = NETWORK_CONNECTION_LIMIT_MS, callbackUrl, secret, onError = console.error }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS exchange_jobs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      startedAt TEXT NOT NULL, readyAt INTEGER NOT NULL, status TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      notify INTEGER NOT NULL DEFAULT 1, available INTEGER NOT NULL DEFAULT 0,
      acknowledged INTEGER NOT NULL DEFAULT 0
    );`);
  const columns = db.prepare('PRAGMA table_info(exchange_jobs)').all();
  if (!columns.some(column => column.name === 'notify')) db.exec('ALTER TABLE exchange_jobs ADD COLUMN notify INTEGER NOT NULL DEFAULT 1');
  if (!columns.some(column => column.name === 'available')) {
    db.exec(`ALTER TABLE exchange_jobs ADD COLUMN available INTEGER NOT NULL DEFAULT 0;
      UPDATE exchange_jobs SET available=${TRADES_PER_PULL} WHERE status='ready';`);
  }
  if (!columns.some(column => column.name === 'acknowledged')) {
    db.exec(`ALTER TABLE exchange_jobs ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0;
      UPDATE exchange_jobs SET acknowledged=${TRADES_PER_PULL} WHERE delivered=1;`);
  }
  if (minimumPendingDelayMs > 0) {
    for (const job of db.prepare("SELECT * FROM exchange_jobs WHERE status='pending' OR delivered=0").all()) {
      const minimumReadyAt = Date.parse(job.startedAt) + minimumPendingDelayMs;
      if (job.readyAt < minimumReadyAt) {
        db.prepare("UPDATE exchange_jobs SET readyAt=?,status='pending',available=0,acknowledged=0,delivered=0 WHERE id=?").run(minimumReadyAt, job.id);
      }
    }
  }
  const workTimers = new Map(), deliveryTimers = new Map(), inFlight = new Set(), waiting = new Map();
  let stopping = false;
  const get = id => db.prepare('SELECT * FROM exchange_jobs WHERE id=?').get(id);
  const totalBatches = TRADES_PER_PULL / TRADES_PER_BATCH;
  const workDuration = job => job.readyAt - Date.parse(job.startedAt);
  const payload = job => ({ jobId: job.id, complete: job.status === 'ready', available: job.available,
    totalTrades: TRADES_PER_PULL, batchSize: TRADES_PER_BATCH, readyAt: new Date(job.readyAt).toISOString(), delayMs: workDuration(job),
    trades: seededTrades(job.sequence, TRADES_PER_PULL, job.startedAt).slice(0, job.available) });
  function schedule(map, id, ms, fn) {
    clearTimeout(map.get(id));
    map.set(id, setTimeout(() => { map.delete(id); void fn(id); }, Math.max(0, ms)));
  }
  async function deliver(id) {
    if (stopping || inFlight.has(id)) return;
    const job = get(id);
    if (!callbackUrl || !job.notify || job.available <= job.acknowledged || job.attempts >= 6) return;
    inFlight.add(id);
    db.prepare('UPDATE exchange_jobs SET attempts=attempts+1 WHERE id=?').run(id);
    let succeeded = false;
    try {
      const response = await fetch(typeof callbackUrl === 'function' ? callbackUrl() : callbackUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BSE-Signature': signature(secret, id) },
        body: JSON.stringify({ jobId: id }), signal: AbortSignal.timeout(connectionLimitMs)
      });
      if (!response.ok) throw new Error(`Callback returned ${response.status}`);
      const acknowledgement = await response.json();
      if (stopping) return;
      const received = acknowledgement.receivedCount;
      if (!Number.isSafeInteger(received) || received < job.available || received > TRADES_PER_PULL) throw new Error('Invalid batch acknowledgement');
      db.prepare('UPDATE exchange_jobs SET acknowledged=MAX(acknowledged,?),delivered=? WHERE id=?')
        .run(received, received === TRADES_PER_PULL ? 1 : 0, id);
      succeeded = true;
    } catch (error) {
      if (stopping) return;
      onError(`Mock callback ${id}: ${error.message}`);
      const current = get(id);
      if (current.attempts < 6) schedule(deliveryTimers, id, Math.min(1000 * 2 ** (current.attempts - 1), 16000), deliver);
    } finally {
      inFlight.delete(id);
      // A work event may have produced a newer batch during this callback.
      // Deliver that pending event once; this is not periodic status polling.
      if (!stopping && succeeded && get(id).available > get(id).acknowledged) schedule(deliveryTimers, id, 0, deliver);
    }
  }
  function armWork(job) {
    if (job.status === 'ready') return;
    const nextBatch = job.available / TRADES_PER_BATCH + 1;
    const dueAt = Date.parse(job.startedAt) + Math.ceil(workDuration(job) * nextBatch / totalBatches);
    schedule(workTimers, job.id, dueAt - Date.now(), advance);
  }
  function advance(id) {
    if (stopping) return;
    const job = get(id);
    const elapsed = Date.now() - Date.parse(job.startedAt);
    const batches = workDuration(job) === 0 ? totalBatches : Math.min(totalBatches, Math.floor(elapsed * totalBatches / workDuration(job)));
    const available = batches * TRADES_PER_BATCH;
    if (available > job.available) {
      db.prepare('UPDATE exchange_jobs SET available=?,status=?,attempts=0 WHERE id=?')
        .run(available, available === TRADES_PER_PULL ? 'ready' : 'pending', id);
      const current = get(id);
      if (current.status === 'ready') {
        for (const res of waiting.get(id) || []) if (!res.destroyed) json(res, 200, payload(current));
        waiting.delete(id);
      }
      armWork(current);
      void deliver(id);
    } else armWork(job); // Never release a batch before its persisted due time.
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, {
      status: 'ok', delayMs, connectionLimitMs, totalTrades: TRADES_PER_PULL, batchSize: TRADES_PER_BATCH, batchIntervalMs: delayMs / totalBatches
    });
    if (req.method !== 'GET' || url.pathname !== '/getTrades') return json(res, 404, { error: 'Not found' });
    const id = url.searchParams.get('jobId') || randomUUID(), asyncRequest = url.searchParams.get('mode') === 'async';
    if (!/^[\w-]{1,80}$/.test(id)) return json(res, 400, { error: 'Invalid job ID' });
    let job = get(id);
    if (!job) {
      const now = new Date();
      db.prepare("INSERT INTO exchange_jobs (id,startedAt,readyAt,status,notify) VALUES (?,?,?,'pending',?)")
        .run(id, now.toISOString(), now.getTime() + delayMs, asyncRequest ? 1 : 0);
      job = get(id); armWork(job);
    } else if (asyncRequest && !job.notify) {
      db.prepare('UPDATE exchange_jobs SET notify=1 WHERE id=?').run(id); job = get(id); void deliver(id);
    }
    if (job.status === 'ready' || (asyncRequest && job.available > 0)) return json(res, 200, payload(job));
    if (asyncRequest) return json(res, 202, { jobId: id, status: 'pending', complete: false, available: 0,
      totalTrades: TRADES_PER_PULL, batchSize: TRADES_PER_BATCH, readyAt: new Date(job.readyAt).toISOString(), delayMs: workDuration(job), delivery: 'webhook' });
    // The synchronous baseline still waits for ALL records and fails at 30s.
    if (!waiting.has(id)) waiting.set(id, new Set());
    waiting.get(id).add(res);
    res.once('close', () => { waiting.get(id)?.delete(res); if (!waiting.get(id)?.size) waiting.delete(id); });
  });
  enforceConnectionLimit(server, connectionLimitMs);
  server.requestTimeout = connectionLimitMs; server.headersTimeout = connectionLimitMs; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  for (const job of db.prepare("SELECT * FROM exchange_jobs WHERE status='pending' OR (notify=1 AND available>acknowledged)").all()) {
    armWork(job);
    if (job.available > job.acknowledged) schedule(deliveryTimers, job.id, 0, deliver);
  }
  return { server, port: server.address().port, close: async () => {
    stopping = true;
    for (const timer of [...workTimers.values(), ...deliveryTimers.values()]) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  } };
}
