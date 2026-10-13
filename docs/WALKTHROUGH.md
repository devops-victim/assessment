# Approach B walkthrough

1. Run `npm start` and open `http://localhost:3000` in two tabs. Show the 300 historical trades, **15:00 report duration** and **30-second network limit**.
2. Open developer tools before clicking **Pull latest trades**. Show the POST response: 202, job ID and `/live?job_id=...`. The request completes immediately.
3. Point out that no partial trade rows appear during generation. Existing trades from earlier completed jobs remain available if this is a later pull. The WebSocket carries only job/connection metadata.
4. Click **Run 30-second timeout test**. Observe the actual connection failure and server log after 30 seconds; the accepted job remains processing.
5. Wait the full 15 minutes. Clearly label any accelerated waiting footage. Live subscriptions renew at 25 seconds before the enforced network cap; no HTTP data/status polling occurs.
6. Show the small completed WebSocket message with `download_url`, followed by exactly one HTTP report download. The table automatically shows 2,300 trades (300 historical + 2,000 newly pulled), and the second tab downloads and updates too.
7. Show search, pagination, CSV export, the architecture diagram and `npm test`. Explain restart/reconnect replay and why the physical socket renews while the durable job continues.

`npm run test:assessment` captures the actual full-duration job-notification protocol with fresh databases. Render that recording with `python scripts/render-video.py`. The included captioned video retains actual timestamps and explicitly labels compressed playback.

The committed video records the earlier empty-start version. Its 15-minute timing evidence remains valid, but it predates the 300-trade historical preload. Re-record with the current scripts to demonstrate append behavior.
