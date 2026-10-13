# Approach B: accept a job, notify completion, download over HTTP

```mermaid
sequenceDiagram
    participant UI as Dashboard
    participant App as Dashboard API
    participant DB as SQLite
    participant BSE as Mock exchange
    UI->>App: GET /api/trades (once on load)
    App-->>UI: Empty first time; cached reports on later visits
    UI->>App: POST /api/pulls
    App->>DB: Persist running job
    App-->>UI: 202 Accepted + job_id + websocket_url
    UI->>App: WS /live?job_id=...
    App-->>UI: Processing metadata (no rows)
    App->>BSE: POST /jobs with same job_id
    BSE-->>App: 202 Accepted
    Note over BSE: Full 900-second report generation; no held HTTP request
    Note over UI,App: Logical job subscription renews at 25s before the 30s hard cap
    BSE->>App: Signed ready callback
    App->>BSE: GET /getTrades?jobId=... (once after ready)
    BSE-->>App: Completed report
    App->>DB: Atomic report import + job completion + associations
    App-->>UI: WS {status: completed, download_url: ...}
    UI->>App: GET download_url (once)
    App-->>UI: This job's trade report
    Note over UI: Render automatically, no page refresh or polling
```

The browser never owns the long-running work. Accepting the job is a short HTTP request, and a durable job ID survives browser closure, connection renewal or backend restart. The first dashboard has zero records. Completed reports persist and remain available while subsequent jobs are processing. No partial records or fabricated startup snapshot are shown.

WebSockets carry small job/connection metadata. Completion is announced only after the completed report and its job-to-trade association commit atomically. The download route returns exactly that job's records, not all historical dashboard trades. The browser merges by trade ID and records successful downloads to suppress duplicate GETs when completion notifications replay.

A job-specific subscription receives that job's explicit events. Compact workspace metadata lets another open tab discover a newly started job and subscribe to it. Durable completed metadata on reconnect covers a completion missed during a disconnect or channel change. One initial cache GET and completion-driven report GETs are not a polling loop.

## Connection and work lifetimes

The application reproduces the original synchronous failure with a real slow GET. A hard timer attached to each accepted socket destroys it after 30 seconds, even when it is waiting for a response. The UI shows the observed network timeout and the terminal records its actual lifetime. A response timeout setting alone would not reproduce this network condition.

This conservative simulation also caps upgraded WebSocket sockets. Therefore, the physical socket renews at 25 seconds while the logical job subscription remains active for the full 15 minutes. If an actual network exempts upgraded WebSockets, one long-lived socket can be used; that exemption is not assumed here. HTTP download occurs only after report generation, so the transfer itself is short for the assessment's few thousand records.

The mock persists an absolute readiness time and uses one requested-job timer. It never publishes a report before that time. Startup recovery restores the remaining delay, and idempotent `POST /jobs` requests use the original job ID. Ready callbacks are HMAC-signed, time-bounded and retried up to six times. The dashboard's job deadline reports missing completion while preserving existing saved reports. No cron job, periodic database scan or automatic pull scheduler is present.

## Upstream assumption

The mock explicitly adds `POST /jobs` and a ready callback. It retains the original synchronous `GET /getTrades`, which fails over the restricted path, and serves the completed report by that GET once ready. This async capability is not a claim about the real BSE API. If an upstream offers only an immutable 15-minute synchronous response and all upstream paths die after 30 seconds, a different upstream interface or a worker outside that network limit is required.

## Scope and verification

SQLite and two logical HTTP services in one local Node process keep setup simple. A partial unique index prevents concurrent duplicate jobs; primary-key deduplication and transactions prevent repeated callbacks from duplicating imports. A larger deployment would add a shared database, durable queue, event fanout, authentication, TLS and object storage/range downloads for large files.

Both services bind to loopback. Seeded exchange trades are fictional. Monetary production code should use decimals or integer minor units. Tests exercise the full browser protocol through real frontend scripts, including one completion-triggered download in each of two open dashboards. The full-duration script verifies 900-second generation, 30-second socket reset, metadata-only WebSockets and HTTP delivery. Chrome visual QA is blocked by sandbox IPC restrictions and remains reproducible through the included Playwright script.
