# Walkthrough: actual assessment constraints

The included captioned video uses actual protocol events from a 15-minute pull and a real 30-second socket reset. It contains no shortened application demo or fabricated timeout. The first 35 seconds play in real time, then the remaining wait is explicitly compressed while preserving recorded timestamps. The raw event JSON accompanies the video.

For a screen recording:

1. Run `npm start`, open `http://localhost:3000`, and point out **15:00 exchange work** and **30 seconds network timeout** in the assessment panel. Open a second dashboard tab.
2. Click **Pull latest trades**. Show immediate acceptance, the running job, and existing saved trades. Search for `TCS`, filter symbols or change pages while the import is running.
3. Click **Run 30-second timeout test**. Watch the elapsed timer advance. At 30 seconds the real synchronous connection fails; show the server-observed socket reset in the UI and terminal.
4. Show that the background job is still running. The live socket renews at 25 seconds and automatically subscribes again; the displayed renewal count increases. Developer tools show only user-triggered HTTP calls and WebSocket event traffic, with no data/status polling.
5. Wait the full 15 minutes. If shortening the recording, label the waiting segment as accelerated footage and keep timestamps visible. After the full delay the trade count increases by 2,000 in both tabs without refresh.
6. Show the completed job, the architecture diagrams and `npm test`. Explain the upstream async extension and why an unchanged synchronous 15-minute response cannot survive a 30-second limit.

`npm run test:assessment` records the complete wall-clock proof using disposable databases; it takes about 15 minutes. `npm run demo` is the same full-duration startup as `npm start`.
