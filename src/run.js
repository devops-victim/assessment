import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createMock } from './mock.js';
import { createApp } from './app.js';
import { integerEnv } from './common.js';
import { runtimeTiming, ASSESSMENT_PULL_MS } from './timing.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const port = integerEnv(process.env.PORT, 3000, 'PORT', 1, 65535);
const mockPort = integerEnv(process.env.MOCK_PORT, 4100, 'MOCK_PORT', 1, 65535);
const { delayMs, connectionLimitMs, wsLifetimeMs } = runtimeTiming();
const dir = resolve(process.env.DATA_DIR || './data/jobs');
await mkdir(dir, { recursive: true });
let secret = process.env.CALLBACK_SECRET;
if (!secret) {
  const path = join(dir, 'callback-secret');
  try { secret = (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(32).toString('hex');
    await writeFile(path, secret, { mode: 0o600, flag: 'wx' });
  }
}
const mock = await createMock({ port: mockPort, dbPath: join(dir, 'exchange.sqlite'), delayMs, minimumPendingDelayMs: ASSESSMENT_PULL_MS, connectionLimitMs, callbackUrl: `http://127.0.0.1:${port}/api/exchange-callback`, secret });
let app;
try { app = await createApp({ port, dbPath: join(dir, 'dashboard.sqlite'), mockUrl: `http://127.0.0.1:${mockPort}`, secret, delayMs, connectionLimitMs, wsLifetimeMs }); }
catch (error) { await mock.close(); throw error; }
console.log(`\nTradeflow dashboard: http://localhost:${port}\nMock BSE API:       http://localhost:${mockPort}/getTrades\nPull duration:      ${delayMs / 60000} minutes (${delayMs} ms)\nNetwork cutoff:     30 seconds (actual socket destruction)\nLive renewal:       25 seconds\nDatabase directory: ${dir}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await mock.close();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
