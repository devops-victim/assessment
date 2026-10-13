# Tradeflow - BSE engineering assessment

A mock BSE API and trades dashboard built around the stated constraints: **15 minutes of exchange work** and a **30-second hard connection lifetime**. Saved trades remain available during a pull; completed batches appear in open dashboards through server push.

## Run

Requires Node.js 24 LTS or newer and npm. No database service, Docker, API keys or frontend build is required.

```sh
npm ci
npm start
```

Open **http://localhost:3000**. The first database starts with 3,000 prior seeded trades. Click **Pull latest trades**: 2,000 new trades are imported **after the full 15-minute delay**, not after 12 seconds or a compressed demo duration. Search, filter and pagination remain usable. Open a second tab to observe automatic completion in both tabs.

`npm run demo` is a compatibility alias for the same normal startup. It no longer changes the delay. Shorter runtime delays are rejected.

## See the actual 30-second failure

On the dashboard, click **Run 30-second timeout test**. This sends a real synchronous request to the slow `GET /getTrades` through the dashboard backend. There is **no browser-side timeout pretending to be the network**. The server's connection limiter actually destroys the socket after 30 seconds.

The UI shows:

- Exchange duration: `15:00`.
- Hard network timeout: `30 seconds`.
- Local elapsed time for the direct request, followed by the actual connection failure.
- A server-observed timeout event with path, socket lifetime and timestamp.
- The live connection's elapsed time and renewals at 25 seconds.

The terminal also logs the socket reset. The direct request fails, while the separate background import keeps running and saved trades remain available. Its trades arrive at 15 minutes without page refresh or an HTTP polling loop.

## Why the background path succeeds

The literal synchronous endpoint is retained to demonstrate the original failure. A 15-minute synchronous response cannot traverse a connection that always dies at 30 seconds.

The mock additionally supports an **explicit async contract**:

1. The app persists a running job and returns `202 Accepted` immediately.
2. It calls `GET /getTrades?mode=async&jobId=<id>`. The exchange persists 15 minutes of work and immediately returns 202 with the real readiness time.
3. When ready, the exchange sends an HMAC-signed callback. The app fetches the ready trades once, atomically saves them and marks the job complete.
4. WebSocket push updates every connected dashboard. Live sockets renew at 25 seconds; missed completion is recovered through a snapshot on reconnect.

The 30-second hard socket lifetime applies to **both HTTP servers, including upgraded WebSocket connections**. `requestTimeout` alone would not enforce a slow response deadline, so the implementation uses a connection-lifetime timer that destroys the socket.

There is no data/status polling, page refresh, cron job or periodic database scan. One-shot timers represent requested exchange work, connection lifetime, callback retries and job deadlines. Frontend elapsed-time counters perform no network requests.

If the actual BSE API cannot support an async interface and its upstream connections also have this hard limit, an upstream interface change or a worker on an unrestricted network path is required. A background worker on the same restricted path cannot make the synchronous response succeed. The mock's async extension is an explicit assumption, not a claim about the real BSE API. See [the architecture note](docs/ARCHITECTURE.md).

## Configuration

Copy `.env.example` to `.env`, or set environment variables. `.env` loads automatically; it and runtime data are Git-ignored.

| Setting | Default | Behavior |
|---|---:|---|
| `PULL_DELAY_MS` | `900000` | At least 15 minutes; longer values are supported and the dashboard displays the actual configured duration |
| `PORT` | `3000` | Dashboard port |
| `MOCK_PORT` | `4100` | Mock exchange port |
| `DATA_DIR` | `./data` | Persistent SQLite databases and generated callback secret |
| `CALLBACK_SECRET` | Generated locally | Shared secret for signed callbacks |

The network limit (`30000` ms) and live renewal (`25000` ms) are assessment constants in `src/timing.js`; environment variables cannot change them. Both HTTP services bind to loopback. Ctrl+C stops them. Restarting preserves saved trades and resumes unfinished exchange jobs using their stored readiness time.

Changing the configured duration affects new exchange jobs; an existing job retains the readiness time it received when started. For review, keep `PULL_DELAY_MS=900000` and complete the current pull before changing configuration.

On upgrade from the previous shortened demo, any unacknowledged short job is extended to at least 15 minutes from its original start. Previously completed trades are preserved.

## APIs

| Service | Endpoint | Result |
|---|---|---|
| Dashboard | `GET /api/trades` | Saved trades, recent jobs, actual timing settings and observed network timeouts |
| Dashboard | `POST /api/pulls` | 202 with a durable job; concurrent triggers reuse the running job |
| Dashboard | `GET /api/direct-pull` | Forwards the literal synchronous exchange GET; the connection is killed at the 30-second network cap |
| Dashboard | `POST /api/exchange-callback` | Signed readiness notification; imports the ready batch |
| Dashboard | `WS /live` | Initial snapshot and server-pushed state changes |
| Dashboard | `GET /api/health` | Health check |
| Mock | `GET /getTrades` | The slow synchronous API: data needs 15 minutes; the network resets its waiting connection at 30 seconds |
| Mock | `GET /getTrades?mode=async&jobId=<id>` | 202 while work is pending; 200 with seeded records when ready |
| Mock | `GET /getTrades?jobId=<ready-id>` | 200 with the completed seeded trade batch |
| Mock | `GET /health` | Health, work duration and network limit |

Each trade contains `tradeId`, `client`, `symbol`, `quantity`, `price` and `timestamp`. Seeds are deterministic per batch. Trade IDs are primary keys, and completing a job is transactional, so retries cannot duplicate or partially apply a batch. The initial 3,000 records are a clearly identified prior seeded snapshot.

## Tests

```sh
npm test
```

Fast automated tests use explicitly reduced timings in **isolated test factories only**. They validate persistence, callbacks, failures, hard HTTP/WebSocket cutoffs, search, pagination, actual timeout rendering and no HTTP polling. Normal application startup cannot select these shortened durations.

For the complete wall-clock proof, taking approximately **15 minutes**:

```sh
npm run test:assessment
```

This uses disposable SQLite databases, starts a real 900-second pull, checks saved trades during the import, makes a direct synchronous request that must reset at about 30 seconds, renews live subscriptions throughout the pull, and asserts that completion occurs no earlier than 900 seconds. It records actual timestamps in `artifacts/walkthrough-events.json`.

Optional Playwright browser verification also uses the **full 15-minute duration**:

```sh
npx playwright install chromium
npm run test:browser
```

Alternatively set `CHROME_PATH` to an installed Chrome executable. The check covers timing displays, the visible 30-second failure, live completion, CSV export and mobile layout, and saves screenshots in `artifacts/`. Chrome IPC is blocked in the development sandbox, so actual browser rendering has not been verified here; the frontend's real scripts are exercised in DOM integration tests.

## Walkthrough

[docs/walkthrough.mp4](docs/walkthrough.mp4) is a captioned architecture and API walkthrough backed by [actual recorded events](docs/walkthrough-events.json). It demonstrates the real 30-second connection reset and the real 15-minute import. The first 35 seconds of protocol footage play in real time; the remaining waiting period is clearly compressed for playback, with actual timestamps retained. It is silent and does not fabricate browser footage.

Reproduce the capture and render (Python 3 with Pillow and opencv-python is required only for video rendering):

```sh
npm run walkthrough
python scripts/render-video.py
```

Generated recordings go to `artifacts/`. [The screen-recording guide](docs/WALKTHROUGH.md) describes an additional browser walkthrough.

## Source map

```text
src/run.js              Runtime configuration and startup
src/timing.js           Assessment limits and actual socket cutoff
src/mock.js             Slow GET, durable async jobs, signed callback
src/app.js              Dashboard API, direct request proxy, WebSocket push
src/store.js            SQLite persistence and atomic imports
src/common.js           Seed generation, JSON and signature utilities
public/                 Dashboard and timing/timeout controls
test/                   Backend, frontend and timing tests
scripts/                Full-duration proof, browser QA and video render
docs/                   Architecture, walkthrough and submission draft
```

## Submission

Publish this repository to your Git host and send its URL and walkthrough to **chirag.g@arhamfintech.ai**, CC **hr@arhamfintech.ai**. An [email draft](docs/SUBMISSION.md) is included. No email has been sent.

Git is initialized, but this sandbox prevents writing `.git/index.lock`, so no commit could be created. From your normal terminal:

```sh
git add .
git commit -m "Implement BSE assessment with real 15-minute pulls and 30-second cutoff"
git branch -M main
git remote add origin <your-repository-url>
git push -u origin main
```
#   a s s e s s m e n t  
 