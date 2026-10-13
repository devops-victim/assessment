import { DatabaseSync } from 'node:sqlite';
import { ASSESSMENT_PULL_MS } from './timing.js';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS trades (
      tradeId TEXT PRIMARY KEY, client TEXT NOT NULL, symbol TEXT NOT NULL,
      quantity INTEGER NOT NULL, price REAL NOT NULL, timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, startedAt TEXT NOT NULL,
      completedAt TEXT, imported INTEGER NOT NULL DEFAULT 0, error TEXT,
      delayMs INTEGER NOT NULL DEFAULT 900000, readyAt TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_pull ON jobs(status) WHERE status='running';`);
  const columns = db.prepare('PRAGMA table_info(jobs)').all();
  if (!columns.some(column => column.name === 'delayMs')) {
    db.exec("ALTER TABLE jobs ADD COLUMN delayMs INTEGER; UPDATE jobs SET delayMs=900000 WHERE status='running'");
  }
  if (!columns.some(column => column.name === 'readyAt')) db.exec('ALTER TABLE jobs ADD COLUMN readyAt TEXT');
  const insert = db.prepare('INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tradeId) DO NOTHING');
  const addTrades = (trades) => {
    let added = 0;
    for (const t of trades) added += Number(insert.run(t.tradeId, t.client, t.symbol, t.quantity, t.price, t.timestamp).changes);
    return added;
  };
  // Remove only the old artificial startup snapshot. Actual pulled trades remain.
  db.prepare("DELETE FROM trades WHERE tradeId LIKE 'BSE-0000-%'").run();
  const applyBatch = (id, trades, complete = false) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job || job.status !== 'running') return 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = addTrades(trades);
      db.prepare('UPDATE jobs SET status=?,completedAt=?,imported=imported+? WHERE id=?')
        .run(complete ? 'completed' : 'running', complete ? new Date().toISOString() : null, count, id);
      db.exec('COMMIT');
      return count;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    db,
    trades: () => db.prepare('SELECT * FROM trades ORDER BY timestamp DESC, tradeId DESC').all(),
    jobs: () => db.prepare('SELECT * FROM jobs ORDER BY startedAt DESC, rowid DESC LIMIT 8').all(),
    active: () => db.prepare("SELECT * FROM jobs WHERE status='running'").get(),
    job: (id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id),
    start: (id, delayMs = ASSESSMENT_PULL_MS) => { db.prepare("INSERT INTO jobs (id,status,startedAt,delayMs) VALUES (?,'running',?,?)").run(id, new Date().toISOString(), delayMs); },
    setReadiness: (id, readyAt, delayMs) => db.prepare("UPDATE jobs SET readyAt=?,delayMs=? WHERE id=? AND status='running'").run(readyAt, delayMs, id),
    fail: (id, error) => db.prepare("UPDATE jobs SET status='failed',completedAt=?,error=? WHERE id=? AND status='running'").run(new Date().toISOString(), error, id),
    applyBatch,
    complete: (id, trades) => applyBatch(id, trades, true),
    close: () => db.close()
  };
}
