# Tradeflow - BSE asynchronous jobs (Approach B)

The dashboard starts empty. An HTTP POST accepts a durable report job immediately. The exchange processes for **15 minutes**, then the app sends a small **WebSocket completion notification with a download URL**. The browser downloads the completed trades over HTTP and renders them automatically. Later visits immediately show genuinely saved trades, including while another pull runs.

## Run

Requires Node.js 24 LTS or newer and npm. No database service or frontend build is needed.

```sh
npm ci
npm start
```

Open **http://localhost:3000** and click **Pull latest trades**. On the first pull the table remains empty while the report is generated. After the real 15-minute duration, all 2,000 trades appear following the automatic HTTP download. Open a second tab to see it receive the same completion notification and download its copy. Search, filtering, pagination and CSV export work on saved trades during later pulls.

`npm run demo` is an alias for the same full-duration startup. Runtime delays shorter than 15 minutes are rejected.

## Protocol

1. `POST /api/pulls` immediately returns **202 Accepted**:

```json
{"job_id":"example-id","websocket_url":"/live?job_id=example-id","job":{"id":"example-id","status":"running"},"alreadyRunning":false}
```

2. Subscribe to the returned job-specific WebSocket URL. The job continues independently of browser connections. No trade rows are transmitted over WebSocket.
3. When the report is committed, the server sends:

```json
{"type":"job","job_id":"example-id","status":"completed","download_url":"/api/pulls/example-id/trades","imported":2000}
```

4. The browser performs **one HTTP GET** to that URL, merges the result into its cached trades and updates the open page. Repeated or replayed notifications do not cause duplicate successful downloads.

The browser makes one initial `GET /api/trades` to load saved data. There is no timed HTTP data/status polling, cron job or automatic pull scheduler. WebSocket messages carry compact job/connection metadata; HTTP carries the report.

## The 30-second limit

Both HTTP services enforce an actual 30-second accepted-socket lifetime. The visible **Run 30-second timeout test** control forwards the original synchronous, slow `GET /getTrades`. The connection is destroyed at 30 seconds and the UI displays the observed failure and server timeout event. The background report job continues unaffected.

The simulation conservatively applies this hard limit to upgraded WebSocket sockets too. A single physical WebSocket therefore cannot be left open for 15 minutes: subscriptions renew at 25 seconds, retaining the same durable job ID. Reconnection replays completion metadata so a missed notification is recoverable. The logical subscription waits for the full report without HTTP polling. If a real network explicitly exempts upgraded WebSocket connections, a persistent socket could instead be used there.

The mock adds an async report interface: the backend starts work with `POST /jobs`, receives a signed callback when ready, fetches the finished `GET /getTrades?jobId=...` once, and commits before notifying browsers. This capability is an explicit mock assumption. An immutable synchronous 15-minute response cannot traverse an upstream path that always drops it at 30 seconds; that situation requires an upstream async interface or an unrestricted worker network path.

## Configuration

Copy `.env.example` to `.env`, or set environment variables. `.env` loads automatically; it and runtime data are Git-ignored.

| Setting | Default | Meaning |
|---|---:|---|
| `PULL_DELAY_MS` | `900000` | Full report duration; minimum 15 minutes |
| `PORT` | `3000` | Dashboard port |
| `MOCK_PORT` | `4100` | Mock exchange port |
| `DATA_DIR` | `./data/jobs` | Fresh job-notification databases and generated callback secret |
| `CALLBACK_SECRET` | Generated locally | Shared secret for signed callbacks |

The network limit (30,000 ms) and subscription renewal (25,000 ms) are constants in `src/timing.js`. Both services bind to loopback. Ctrl+C stops them. Saved reports and unfinished jobs survive restart. An existing job retains its original readiness time when new-job configuration changes.

This version starts with a fresh data folder, preserving earlier prototype databases in `data/`. Reusing an older `DATA_DIR` removes only the artificial `BSE-0000-*` startup seed and retains received records; use the new default directory for an empty review run.

## API

| Service | Endpoint | Result |
|---|---|---|
| Dashboard | `GET /api/trades` | Initial cache read: saved trades, jobs and timing |
| Dashboard | `POST /api/pulls` | Immediate 202 with job ID and WebSocket URL |
| Dashboard | `WS /live?job_id=<id>` | Job-scoped events; completion includes `download_url` |
| Dashboard | `WS /live` | Workspace metadata used to discover jobs started in another tab |
| Dashboard | `GET /api/pulls/<id>/trades` | Completed job's report only; 409 while processing, 404 for unknown jobs |
| Dashboard | `GET /api/direct-pull` | Real synchronous-request timeout demonstration |
| Dashboard | `POST /api/exchange-callback` | Signed internal readiness notification |
| Dashboard | `GET /api/health` | Health check |
| Mock | `POST /jobs` | Accept report generation immediately; supplied `job_id` is idempotent |
| Mock | `GET /getTrades?jobId=<ready-id>` | Seeded completed trade report |
| Mock | `GET /getTrades` | Slow synchronous baseline, reset at 30 seconds |
| Mock | `GET /health` | Health and configured timing |

Trades contain trade ID, client, symbol, quantity, price and timestamp. Report imports and job-to-trade associations are atomic, deduplicated and persistent. One active pull is permitted; concurrent triggers reuse its ID.

## Verify

```sh
npm test
```

Tests cover empty startup, immediate acceptance, job-scoped events, metadata-only WebSockets, one HTTP download per completed job, multiple open dashboards, reconnect replay, restart recovery, callback signatures, origin checks, failures, transaction rollback, per-job report isolation, real socket resets and absence of HTTP polling. Fast test factories explicitly shorten their isolated delays; normal startup cannot do so.

For the full **15-minute wall-clock check** and recorded protocol evidence:

```sh
npm run test:assessment
```

Optional real-browser QA also uses the full duration:

```sh
npx playwright install chromium
npm run test:browser
```

Alternatively set `CHROME_PATH` to an installed Chrome executable. The Windows sandbox blocks Chrome IPC, so visual browser QA is not verified here; the real frontend scripts are covered by DOM integration tests.

## Deliverables

- [Architecture and diagram](docs/ARCHITECTURE.md)
- [Captioned walkthrough video](docs/walkthrough.mp4) and [recorded events](docs/walkthrough-events.json)
- [Browser screen-recording guide](docs/WALKTHROUGH.md)
- [Submission email draft](docs/SUBMISSION.md)

The video preserves actual elapsed timestamps and labels its compressed waiting segment. To reproduce it, run `npm run walkthrough` followed by `python scripts/render-video.py` (Pillow and opencv-python are needed only for rendering). Generated artifacts go to `artifacts/`.

Publish the repository to your Git host before sending the draft to **chirag.g@arhamfintech.ai**, CC **hr@arhamfintech.ai**. No email has been sent. This sandbox cannot create Git commits; use your normal terminal to stage, commit and push the final files.
