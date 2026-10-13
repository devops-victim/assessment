import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { system } from './helpers.js';

function waitFor(window, predicate, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(timer); reject(new Error('Dashboard did not reach expected state')); }
    }, 10);
  });
}

test('dashboard shows historical trades, appends a completed report, and filters during later jobs', async t => {
  const s = await system({ delayMs: 2000, wsLifetimeMs: 150, initialTradeCount: 300 }); t.after(() => s.close());
  const httpRequests = [];
  const dom = await JSDOM.fromURL(s.url, {
    resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.AbortSignal = AbortSignal;
      window.fetch = (path, options) => { httpRequests.push(path); return fetch(s.url + path, options); };
    }
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  await waitFor(w, () => d.getElementById('total-trades').textContent === '300');
  assert.equal(d.querySelectorAll('#trade-rows tr').length, 10);
  assert.equal(d.getElementById('empty-state').hidden, true);
  assert.equal(d.getElementById('export-button').disabled, false);
  assert.match(d.getElementById('activity-list').textContent, /No pulls yet/);
  d.getElementById('pull-button').click();
  await waitFor(w, () => d.getElementById('pull-button-label').textContent === 'Pull in progress');
  assert.equal(d.getElementById('pull-button').disabled, true);
  assert.equal(d.querySelectorAll('#trade-rows tr').length, 10);
  assert.equal(d.getElementById('total-trades').textContent, '300');
  assert.match(d.getElementById('pull-title').textContent, /Generating/);
  await waitFor(w, () => d.getElementById('total-trades').textContent === '2,300');
  assert.equal(d.getElementById('pull-button').disabled, false);
  assert.match(d.getElementById('toast').textContent, /2,000 trades downloaded/);
  assert.equal(httpRequests.length, 3);
  assert.deepEqual(httpRequests.slice(0, 2), ['/api/trades', '/api/pulls']);
  assert.match(httpRequests[2], /^\/api\/pulls\/[\w-]+\/trades$/);
  d.getElementById('pull-button').click();
  await waitFor(w, () => d.getElementById('pull-button').disabled === true);
  assert.equal(d.getElementById('total-trades').textContent, '2,300');
  const search = d.getElementById('search'); search.value = 'TCS'; search.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#trade-rows .symbol-badge').length, 10);
  assert.ok([...d.querySelectorAll('#trade-rows .symbol-badge')].every(e => e.textContent === 'TCS'));
  d.getElementById('next').click(); assert.match(d.getElementById('page-number').textContent, /^2 \/ /);
  search.value = 'no-such-trade'; search.dispatchEvent(new w.Event('input'));
  assert.equal(d.getElementById('empty-state').hidden, false);
  search.value = ''; search.dispatchEvent(new w.Event('input'));
  assert.equal(httpRequests.length, 4, 'Initial cache, first POST, completed download, second POST; no polling');
  assert.equal(d.getElementById('connection-label').textContent, 'Live connection');
});

test('timeout control shows a real dropped request and server-observed cutoff', async t => {
  const s = await system({ delayMs: 2000, connectionLimitMs: 500, wsLifetimeMs: 200 }); t.after(() => s.close());
  const requests = [];
  const dom = await JSDOM.fromURL(s.url, { resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) { window.AbortSignal = AbortSignal; window.fetch = (path, options) => { requests.push(path); return fetch(s.url + path, options); }; }
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  await waitFor(w, () => d.getElementById('total-trades').textContent === '0');
  assert.equal(d.getElementById('configured-duration').textContent, '0:02');
  assert.equal(d.getElementById('network-limit').textContent, '0.5 seconds');
  d.getElementById('timeout-button').click();
  assert.equal(d.getElementById('timeout-button').disabled, true);
  await waitFor(w, () => d.getElementById('timeout-result').textContent.includes('connection failed'));
  await waitFor(w, () => !d.getElementById('network-event').hidden);
  assert.match(d.getElementById('network-event').textContent, /socket killed/);
  assert.match(d.getElementById('network-event').textContent, /\/api\/direct-pull/);
  assert.equal(d.getElementById('timeout-button').disabled, false);
  assert.equal(d.getElementById('total-trades').textContent, '0');
  assert.deepEqual(requests, ['/api/trades', '/api/direct-pull']);
});

test('another open dashboard subscribes to a newly started job and downloads the same completed report', async t => {
  const s = await system({ delayMs: 700, wsLifetimeMs: 150 }); t.after(() => s.close());
  const requests = [[], []], doms = [];
  for (let i = 0; i < 2; i++) {
    doms.push(await JSDOM.fromURL(s.url, { resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) { window.AbortSignal = AbortSignal; window.fetch = (path, options) => { requests[i].push(path); return fetch(s.url + path, options); }; }
    }));
  }
  t.after(() => { for (const dom of doms) dom.window.close(); });
  await Promise.all(doms.map(dom => waitFor(dom.window, () => dom.window.document.getElementById('total-trades').textContent === '0')));
  doms[0].window.document.getElementById('pull-button').click();
  await Promise.all(doms.map(dom => waitFor(dom.window, () => dom.window.document.getElementById('total-trades').textContent === '2,000')));
  assert.equal(requests[0].length, 3); assert.equal(requests[1].length, 2);
  assert.match(requests[0][2], /\/trades$/); assert.equal(requests[1][1], requests[0][2]);
});
