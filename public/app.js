const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('en-IN');
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const time = value => new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
let trades = [], jobs = [], delayMs = 900000, page = 1;
let ws, reconnectTimer, retry = 0, sending = false, toastTimer, clockOffset = 0, unloading = false;
let connectionLimitMs = 30000, wsLifetimeMs = 25000, connectedAt = 0, renewals = 0;
let timeoutTestStartedAt = 0, timeoutTestRunning = false;
let totalTrades = 2000, subscribedJobId = null, lastState;
const downloadedJobs = new Set(), downloadsInFlight = new Set();
const pageSize = 10;
$('today').textContent = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
function text(id, value) { $(id).textContent = value; }
function active() { return jobs.find(job => job.status === 'running'); }
function currentPullDuration() { return active()?.delayMs ?? delayMs; }
function toast(message) {
  text('toast', message); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function filtered() {
  const search = $('search').value.toLowerCase().trim();
  const symbol = $('symbol-filter').value;
  return trades.filter(t => (!symbol || t.symbol === symbol) && (!search || `${t.tradeId} ${t.client} ${t.symbol}`.toLowerCase().includes(search)));
}
function renderTable() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  page = Math.min(page, pages);
  const rows = list.slice((page - 1) * pageSize, page * pageSize);
  $('trade-rows').replaceChildren(...rows.map(t => {
    const row = document.createElement('tr');
    const fields = [t.tradeId, t.client, t.symbol, format.format(t.quantity), money.format(t.price), time(t.timestamp)];
    const classes = ['trade-id', 'client-name', '', 'numeric', 'numeric price', 'trade-time'];
    fields.forEach((value, i) => {
      const cell = document.createElement('td'); cell.className = classes[i];
      if (i === 2) { const badge = document.createElement('span'); badge.className = 'symbol-badge'; badge.textContent = value; cell.append(badge); }
      else cell.textContent = value;
      row.append(cell);
    });
    row.lastChild.title = `${new Date(t.timestamp).toLocaleDateString('en-IN')} · IST`;
    return row;
  }));
  text('blotter-count', format.format(list.length));
  text('page-info', list.length ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, list.length)} of ${format.format(list.length)} trades` : '0 trades');
  text('page-number', `${page} / ${pages}`);
  $('empty-state').hidden = list.length !== 0;
  text('empty-state', trades.length === 0 ? (active() ? 'Generating the report. Trades will appear after completion and download.' : 'No trades yet. Start a pull to generate your first report.') : 'No trades match your filters.');
  $('export-button').disabled = list.length === 0;
  $('prev').disabled = page <= 1; $('next').disabled = page >= pages;
}
function renderActivity() {
  const entries = jobs.slice(0, 4);
  if (!entries.length) {
    const empty = document.createElement('p'); empty.className = 'side-description'; empty.textContent = 'No pulls yet. Start your first exchange pull.';
    $('activity-list').replaceChildren(empty); return;
  }
  $('activity-list').replaceChildren(...entries.map(job => {
    const row = document.createElement('div'); row.className = 'activity-item';
    const marker = document.createElement('span'); marker.className = `activity-marker ${job.status}`;
    marker.textContent = job.status === 'running' ? '↻' : job.status === 'failed' ? '!' : '✓';
    const content = document.createElement('div'); content.className = 'activity-text';
    const title = document.createElement('strong');
    title.textContent = job.status === 'running' ? 'Pull in progress' : job.status === 'failed' ? 'Pull failed' : 'Pull completed';
    const detail = document.createElement('p'); detail.textContent = job.status === 'running' ? 'Generating report in the background' : job.status === 'failed' ? 'Existing saved trades remain available' : `${format.format(job.imported)} trades ready to download`;
    const at = document.createElement('small'); at.textContent = `${time(job.completedAt || job.startedAt)} IST · ${job.id.slice(0, 8)}`;
    if (job.error) detail.title = job.error;
    content.append(title, detail, at); row.append(marker, content); return row;
  }));
}
function renderPullStatus() {
  const running = active();
  const latest = jobs[0];
  const failed = !running && latest?.status === 'failed';
  const banner = document.querySelector('.pull-banner');
  banner.classList.toggle('running', !!running); banner.classList.toggle('failed', failed);
  $('pull-button').disabled = !!running || sending;
  text('pull-button-label', running ? 'Pull in progress' : sending ? 'Starting pull…' : 'Pull latest trades');
  text('banner-icon', running ? '↻' : failed ? '!' : '✓');
  const awaitingDownload = latest?.status === 'completed' && !downloadedJobs.has(latest.id);
  text('pull-title', running ? 'Generating your trade report in the background' : failed ? 'The last pull could not complete' : awaitingDownload ? 'Report completed. Downloading trades…' : latest ? 'All caught up. Your latest trades are here.' : trades.length ? 'Your saved trades are ready' : 'Start your first exchange pull');
  text('pull-description', running ? `Job ${running.id.slice(0, 8)} takes ${duration(currentPullDuration())}. A WebSocket notification will trigger the HTTP download when ready.` : failed ? latest.error : `Generate ${format.format(totalTrades)} trades in ${duration(delayMs)}. Existing trades stay available while the job runs.`);
  text('pull-pill', running ? 'PULLING' : failed ? 'FAILED' : latest ? 'SYNCED' : 'READY');
  updateClock();
}
function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function updateClock() {
  if (connectedAt) {
    text('live-clock', `${duration(Date.now() - connectedAt)} / ${duration(wsLifetimeMs)}`);
    text('live-renewals', `${renewals} renewals · hard cutoff at ${connectionLimitMs / 1000}s`);
  }
  if (timeoutTestRunning) {
    text('timeout-result', `Synchronous GET waiting: ${duration(Date.now() - timeoutTestStartedAt)} / ${duration(connectionLimitMs)} until connection cutoff. The pull requires ${duration(delayMs)}.`);
  }
  const job = active();
  if (!job) { text('pull-clock', 'On-demand sync'); $('progress').style.width = '0%'; return; }
  const pullDuration = currentPullDuration();
  const startedAt = job.readyAt ? Date.parse(job.readyAt) - pullDuration : Date.parse(job.startedAt);
  const elapsed = Math.max(0, Date.now() + clockOffset - startedAt);
  text('pull-clock', `${duration(elapsed)} / ${duration(pullDuration)}`);
  $('progress').style.width = `${Math.min(95, elapsed / Math.max(1, pullDuration) * 100)}%`;
}
function applySnapshot(data) {
  lastState = data;
  trades = data.trades ?? trades; jobs = data.jobs; delayMs = data.delayMs;
  totalTrades = data.totalTrades;
  connectionLimitMs = data.connectionLimitMs; wsLifetimeMs = data.wsLifetimeMs;
  clockOffset = data.serverTime - Date.now();
  text('configured-duration', duration(currentPullDuration()));
  text('batch-cadence', 'Job completed event → one HTTP download');
  text('network-limit', `${connectionLimitMs / 1000} seconds`);
  const cutoff = data.networkTimeouts[0];
  if (cutoff) {
    text('network-event', `Observed network timeout: ${cutoff.kind} ${cutoff.path} socket killed after ${(cutoff.elapsedMs / 1000).toFixed(2)} seconds (limit ${cutoff.limitMs / 1000}s). ${time(cutoff.timedOutAt)} IST.`);
    $('network-event').hidden = false;
  }
  const completed = jobs.filter(j => j.status === 'completed');
  text('total-trades', format.format(trades.length));
  const total = trades.reduce((sum, t) => sum + t.quantity * t.price, 0);
  text('traded-value', `₹${(total / 10000000).toFixed(2)} Cr`);
  $('traded-value').title = money.format(total);
  text('active-clients', new Set(trades.map(t => t.client)).size);
  text('symbol-count', new Set(trades.map(t => t.symbol)).size);
  const success = completed[0];
  text('last-pull', success ? time(success.completedAt).slice(0, 5) + ' IST' : 'Not pulled yet');
  text('last-pull-caption', success ? `${format.format(success.imported)} trades added · ${new Date(success.completedAt).toLocaleDateString('en-IN')}` : 'No pulls completed yet');
  text('total-caption', 'Saved exchange records');
  const selection = $('symbol-filter').value;
  $('symbol-filter').replaceChildren(...['', ...new Set(trades.map(t => t.symbol).sort())].map(s => {
    const option = document.createElement('option'); option.value = s; option.textContent = s || 'All symbols'; return option;
  }));
  $('symbol-filter').value = selection;
  renderTable(); renderActivity(); renderPullStatus();
  // Replay completed metadata from a renewed subscription to recover any result
  // missed while switching job channels. Each job downloads at most once.
  for (const job of completed) if (job.download_url && !downloadedJobs.has(job.id)) {
    void downloadCompletedJob({ job_id: job.id, download_url: job.download_url });
  }
}
function subscribeToJob(id) {
  if (subscribedJobId === id && ws && ws.readyState <= WebSocket.OPEN) return;
  subscribedJobId = id;
  const old = ws; ws = null; old?.close(); connect();
}
async function downloadCompletedJob(event) {
  if (downloadedJobs.has(event.job_id) || downloadsInFlight.has(event.job_id)) return;
  downloadsInFlight.add(event.job_id); renderPullStatus();
  try {
    const expectedUrl = `/api/pulls/${encodeURIComponent(event.job_id)}/trades`;
    if (event.download_url !== expectedUrl) throw new Error('Invalid download URL');
    const response = await fetch(event.download_url, { signal: AbortSignal.timeout(connectionLimitMs) });
    const result = await response.json();
    if (!response.ok || result.job_id !== event.job_id || !Array.isArray(result.trades)) throw new Error(result.error || 'Could not download completed report');
    const merged = new Map(trades.map(t => [t.tradeId, t]));
    for (const trade of result.trades) merged.set(trade.tradeId, trade);
    downloadedJobs.add(event.job_id);
    applySnapshot({ ...lastState, serverTime: Date.now() + clockOffset,
      trades: [...merged.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.tradeId.localeCompare(a.tradeId)) });
    toast(`${format.format(result.trades.length)} trades downloaded. You're up to date.`);
  } catch (error) { text('error', `Report download failed: ${error.message}`); $('error').hidden = false; }
  finally { downloadsInFlight.delete(event.job_id); renderPullStatus(); }
}
function connect() {
  if (unloading) return;
  clearTimeout(reconnectTimer);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live${subscribedJobId ? '?job_id=' + encodeURIComponent(subscribedJobId) : ''}`);
  ws = socket;
  socket.addEventListener('open', () => {
    if (socket !== ws) return;
    connectedAt = Date.now();
    retry = 0; $('connection').classList.remove('offline'); text('connection-label', 'Live connection');
    $('error').hidden = true;
  });
  socket.addEventListener('message', event => {
    if (socket !== ws) return;
    const data = JSON.parse(event.data);
    if (data.type === 'snapshot') {
      applySnapshot(data);
      if (active() && active().id !== subscribedJobId) subscribeToJob(active().id);
    } else if (data.type === 'job' && data.status === 'completed') void downloadCompletedJob(data);
  });
  socket.addEventListener('close', event => {
    if (socket !== ws) return;
    if (unloading) return;
    connectedAt = 0;
    if (event.code === 4000) renewals++;
    if (event.code !== 4000) { $('connection').classList.add('offline'); text('connection-label', 'Reconnecting…'); }
    // Transport reconnection only. No timed HTTP requests or status polling.
    const wait = event.code === 4000 ? 0 : Math.min(500 * 2 ** retry++, 10000) + Math.random() * 250;
    reconnectTimer = setTimeout(connect, wait);
  });
  socket.addEventListener('error', () => socket.close());
}
$('pull-button').addEventListener('click', async () => {
  sending = true; renderPullStatus(); $('error').hidden = true;
  try {
    const response = await fetch('/api/pulls', { method: 'POST', signal: AbortSignal.timeout(connectionLimitMs) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start pull');
    if (!jobs.some(j => j.id === data.job.id)) jobs.unshift(data.job);
    subscribeToJob(data.job_id);
    renderActivity();
    toast(data.alreadyRunning ? 'A pull is already running in this workspace.' : 'Pull started. You can keep using the dashboard.');
  } catch (error) { text('error', `Could not start the pull: ${error.message}`); $('error').hidden = false; }
  finally { sending = false; renderPullStatus(); }
});
$('timeout-button').addEventListener('click', async () => {
  timeoutTestStartedAt = Date.now(); timeoutTestRunning = true;
  $('timeout-button').disabled = true; $('timeout-button').textContent = 'Waiting for network cutoff…';
  updateClock();
  try {
    // No client timeout: failure must come from the enforced network socket cap.
    const response = await fetch('/api/direct-pull', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    text('timeout-result', 'The synchronous GET completed. Check the displayed configuration and server logs.');
  } catch (error) {
    const elapsed = (Date.now() - timeoutTestStartedAt) / 1000;
    text('timeout-result', `Synchronous GET connection failed after ${elapsed.toFixed(2)} seconds. Network limit: ${connectionLimitMs / 1000}s; exchange work: ${duration(delayMs)}. The background pull and saved trades are unaffected.`);
  } finally {
    timeoutTestRunning = false; $('timeout-button').disabled = false;
    $('timeout-button').textContent = 'Run 30-second timeout test';
  }
});
$('search').addEventListener('input', () => { page = 1; renderTable(); });
$('symbol-filter').addEventListener('change', () => { page = 1; renderTable(); });
$('prev').addEventListener('click', () => { page--; renderTable(); });
$('next').addEventListener('click', () => { page++; renderTable(); });
$('export-button').addEventListener('click', () => {
  const fields = ['tradeId', 'client', 'symbol', 'quantity', 'price', 'timestamp'];
  const cell = value => `"${String(value).replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
  const csv = [fields.join(','), ...filtered().map(t => fields.map(f => cell(t[f])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'bse-trades.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
// This timer only paints local elapsed time; it never requests data.
setInterval(updateClock, 1000);
window.addEventListener('beforeunload', () => { unloading = true; clearTimeout(reconnectTimer); ws?.close(); });
async function initialize() {
  try {
    // One initial cache read, never a polling loop.
    const response = await fetch('/api/trades', { signal: AbortSignal.timeout(connectionLimitMs) });
    if (!response.ok) throw new Error('Could not load saved trades');
    const data = await response.json();
    for (const job of data.jobs) if (job.status === 'completed') downloadedJobs.add(job.id);
    applySnapshot(data);
    subscribedJobId = active()?.id ?? null;
  } catch (error) { text('error', error.message); $('error').hidden = false; }
  connect();
}
void initialize();
