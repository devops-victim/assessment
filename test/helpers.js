import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createMock } from '../src/mock.js';

export async function system(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tradeflow-'));
  const secret = 'test-only-secret';
  let app;
  const mock = await createMock({ port: 0, dbPath: join(dir, 'mock.sqlite'), delayMs: options.delayMs ?? 120, connectionLimitMs: options.connectionLimitMs ?? 30000,
    callbackUrl: () => `http://127.0.0.1:${app.port}/api/exchange-callback`, secret, onError: () => {} });
  const config = { port: 0, dbPath: join(dir, 'app.sqlite'), mockUrl: `http://127.0.0.1:${mock.port}`, secret,
    delayMs: options.delayMs ?? 120, connectionLimitMs: options.connectionLimitMs ?? 30000, wsLifetimeMs: options.wsLifetimeMs ?? 25000, deadlineGraceMs: options.deadlineGraceMs ?? 120000 };
  app = await createApp(config);
  return {
    get app() { return app; }, mock, dir, secret,
    get url() { return `http://127.0.0.1:${app.port}`; },
    async restartApp(overrides = {}) { const port = app.port; await app.close(); app = await createApp({ ...config, ...overrides, port }); },
    async close() { await mock.close(); await app.close(); await rm(dir, { recursive: true, force: true }); }
  };
}

export function waitSnapshot(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('Timed out waiting for pushed snapshot')); }, timeout);
    function onMessage(raw) {
      const data = JSON.parse(raw.toString());
      if (predicate(data)) { clearTimeout(timer); ws.off('message', onMessage); resolve(data); }
    }
    ws.on('message', onMessage);
  });
}
