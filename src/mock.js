import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { json, readJson, seededTrades, signature } from './common.js';
import { ASSESSMENT_PULL_MS, NETWORK_CONNECTION_LIMIT_MS, TRADES_PER_PULL, enforceConnectionLimit } from './timing.js';

export async function createMock({ port = 4100, dbPath = ':memory:', delayMs = ASSESSMENT_PULL_MS, minimumPendingDelayMs = 0,
  connectionLimitMs = NETWORK_CONNECTION_LIMIT_MS, callbackUrl, secret, onError = console.error }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS exchange_jobs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      startedAt TEXT NOT NULL, readyAt INTEGER NOT NULL, status TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, notify INTEGER NOT NULL DEFAULT 1
    );`);
  if (!db.prepare('PRAGMA table_info(exchange_jobs)').all().some(c => c.name === 'notify')) db.exec('ALTER TABLE exchange_jobs ADD COLUMN notify INTEGER NOT NULL DEFAULT 1');
  if (minimumPendingDelayMs > 0) {
    for (const job of db.prepare("SELECT * FROM exchange_jobs WHERE status='pending' OR delivered=0").all()) {
      const minimum = Date.parse(job.startedAt) + minimumPendingDelayMs;
      if (job.readyAt < minimum) db.prepare("UPDATE exchange_jobs SET readyAt=?,status='pending' WHERE id=?").run(minimum, job.id);
    }
  }
  const timers = new Map(), waiting = new Map();
  let stopping = false;
  const get = id => db.prepare('SELECT * FROM exchange_jobs WHERE id=?').get(id);
  const metadata = job => ({ job_id: job.id, jobId: job.id, status: job.status === 'ready' ? 'completed' : 'processing',
    readyAt: new Date(job.readyAt).toISOString(), delayMs: job.readyAt - Date.parse(job.startedAt),
    download_url: `/getTrades?jobId=${encodeURIComponent(job.id)}` });
  const payload = job => ({ ...metadata(job), trades: seededTrades(job.sequence, TRADES_PER_PULL, job.startedAt,
    (job.readyAt - Date.parse(job.startedAt)) / TRADES_PER_PULL) });
  function schedule(id, ms, fn) {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { timers.delete(id); void fn(id); }, Math.max(0, ms)));
  }
  async function deliver(id) {
    if (stopping) return;
    const job = get(id);
    if (!callbackUrl || !job.notify || job.delivered || job.attempts >= 6) return;
    db.prepare('UPDATE exchange_jobs SET attempts=attempts+1 WHERE id=?').run(id);
    try {
      const response = await fetch(typeof callbackUrl === 'function' ? callbackUrl() : callbackUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BSE-Signature': signature(secret, id) },
        body: JSON.stringify({ jobId: id }), signal: AbortSignal.timeout(connectionLimitMs)
      });
      if (!response.ok) throw new Error(`Callback returned ${response.status}`);
      await response.arrayBuffer();
      if (!stopping) db.prepare('UPDATE exchange_jobs SET delivered=1 WHERE id=?').run(id);
    } catch (error) {
      if (stopping) return;
      onError(`Mock callback ${id}: ${error.message}`);
      if (job.attempts < 5) schedule(id, Math.min(1000 * 2 ** job.attempts, 16000), deliver);
    }
  }
  async function ready(id) {
    if (stopping) return;
    if (get(id).readyAt > Date.now()) return schedule(id, get(id).readyAt - Date.now(), ready);
    db.prepare("UPDATE exchange_jobs SET status='ready' WHERE id=?").run(id);
    for (const res of waiting.get(id) || []) if (!res.destroyed) json(res, 200, payload(get(id)));
    waiting.delete(id);
    await deliver(id);
  }
  function accept(id, notify) {
    let job = get(id);
    if (!job) {
      const now = new Date();
      db.prepare("INSERT INTO exchange_jobs(id,startedAt,readyAt,status,notify) VALUES (?,?,?,'pending',?)")
        .run(id, now.toISOString(), now.getTime() + delayMs, notify ? 1 : 0);
      job = get(id); schedule(id, delayMs, ready);
    }
    return job;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', delayMs, connectionLimitMs, totalTrades: TRADES_PER_PULL });
      if (req.method === 'POST' && url.pathname === '/jobs') {
        const body = await readJson(req);
        const id = body.job_id || randomUUID();
        if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) return json(res, 400, { error: 'Invalid job ID' });
        const job = accept(id, true);
        return json(res, job.status === 'ready' ? 200 : 202, metadata(job));
      }
      if (req.method !== 'GET' || url.pathname !== '/getTrades') return json(res, 404, { error: 'Not found' });
      const id = url.searchParams.get('jobId') || randomUUID(), asyncRequest = url.searchParams.get('mode') === 'async';
      if (!/^[\w-]{1,80}$/.test(id)) return json(res, 400, { error: 'Invalid job ID' });
      const job = accept(id, asyncRequest);
      if (job.status === 'ready') return json(res, 200, payload(job));
      if (asyncRequest) return json(res, 202, metadata(job));
      // The synchronous baseline holds its response and is killed at 30 seconds.
      if (!waiting.has(id)) waiting.set(id, new Set());
      waiting.get(id).add(res);
      res.once('close', () => { waiting.get(id)?.delete(res); if (!waiting.get(id)?.size) waiting.delete(id); });
    } catch (error) { json(res, 400, { error: error.message }); }
  });
  enforceConnectionLimit(server, connectionLimitMs);
  server.requestTimeout = connectionLimitMs; server.headersTimeout = connectionLimitMs; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  for (const job of db.prepare("SELECT * FROM exchange_jobs WHERE status='pending' OR (notify=1 AND delivered=0)").all()) {
    schedule(job.id, job.status === 'ready' ? 0 : job.readyAt - Date.now(), job.status === 'ready' ? deliver : ready);
  }
  return { server, port: server.address().port, close: async () => {
    stopping = true; for (const timer of timers.values()) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  } };
}
