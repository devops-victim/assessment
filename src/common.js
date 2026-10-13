import { createHmac, timingSafeEqual } from 'node:crypto';

export const symbols = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'ITC', 'LT', 'SBIN'];
const prices = [2941, 4120, 1682, 1870, 1264, 486, 3540, 811];
const clients = ['Arham Capital', 'Meridian Securities', 'Northstar Fund', 'Pioneer Investments', 'Atlas Trading', 'Summit Partners'];

export function seededTrades(batch = 0, count = 2000, baseTime = '2026-10-13T04:30:00.000Z') {
  let seed = 20261013 + batch * 7919;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: count }, (_, i) => {
    const s = Math.floor(random() * symbols.length);
    return {
      tradeId: `BSE-${String(batch).padStart(4, '0')}-${String(i + 1).padStart(6, '0')}`,
      client: clients[Math.floor(random() * clients.length)],
      symbol: symbols[s],
      quantity: (Math.floor(random() * 100) + 1) * 10,
      price: Math.round(prices[s] * (0.98 + random() * 0.04) * 100) / 100,
      timestamp: new Date(Date.parse(baseTime) + i * 1000).toISOString()
    };
  });
}

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readJson(req, maxBytes = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function signature(secret, jobId) {
  return createHmac('sha256', secret).update(jobId).digest('hex');
}

export function verifySignature(secret, jobId, candidate = '') {
  if (typeof jobId !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(signature(secret, jobId)), Buffer.from(candidate));
}

export function integerEnv(value, fallback, name, min = 1, max = 2147483647) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
