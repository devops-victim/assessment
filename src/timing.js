import { integerEnv } from './common.js';

export const ASSESSMENT_PULL_MS = 15 * 60 * 1000;
export const NETWORK_CONNECTION_LIMIT_MS = 30 * 1000;
export const LIVE_RENEWAL_MS = 25 * 1000;
export const TRADES_PER_PULL = 2000;

export function runtimeTiming(env = process.env) {
  return {
    // Configurable for longer pulls, but the assessed application cannot silently
    // substitute a short demo for the problem statement's 15-minute work.
    delayMs: integerEnv(env.PULL_DELAY_MS, ASSESSMENT_PULL_MS, 'PULL_DELAY_MS', ASSESSMENT_PULL_MS),
    connectionLimitMs: NETWORK_CONNECTION_LIMIT_MS,
    wsLifetimeMs: LIVE_RENEWAL_MS
  };
}

// Model the network's HARD connection lifetime, including upgraded sockets.
// requestTimeout / keepAliveTimeout alone do not limit a slow HTTP response.
export function enforceConnectionLimit(server, limitMs, onTimeout = () => {}) {
  server.on('connection', socket => {
    const connectedAt = Date.now();
    let deadline;
    function expire() {
      const remaining = limitMs - (Date.now() - connectedAt);
      if (remaining > 0) { deadline = setTimeout(expire, remaining); return; }
      const event = { connectedAt, timedOutAt: Date.now(), elapsedMs: Date.now() - connectedAt,
        limitMs, path: socket.tradeflowPath || null, kind: socket.tradeflowKind || 'Idle' };
      socket.destroy();
      onTimeout(event);
    }
    deadline = setTimeout(expire, limitMs);
    socket.once('close', () => clearTimeout(deadline));
  });
  server.on('request', (req) => {
    req.socket.tradeflowPath = new URL(req.url, 'http://localhost').pathname;
    req.socket.tradeflowKind = 'HTTP';
  });
  server.on('upgrade', req => {
    req.socket.tradeflowPath = '/live';
    req.socket.tradeflowKind = 'WebSocket';
  });
}
