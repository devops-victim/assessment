# Submission email draft

To: chirag.g@arhamfintech.ai  
CC: hr@arhamfintech.ai  
Subject: Technical Assessment – Software Engineer – [Your name]

Hi Chirag and HR Team,

Please find my completed technical assessment:

- Git repository: [add your repository URL]
- Setup instructions: README.md in the repository
- Architecture note and diagram: docs/ARCHITECTURE.md
- Video walkthrough: docs/walkthrough.mp4 in the repository [or add an accessible video link]

The dashboard shows saved trades immediately and imports new batches after the full 15-minute delay. Completed pulls update all open dashboards via WebSocket push without page refresh, HTTP polling or a cron job. The application enforces the 30-second hard socket lifetime and includes a visible test of the original synchronous request failure.

The architecture note explains the async exchange handshake needed to respect the 30-second connection limit, persistence, reconnect/restart recovery, and implementation tradeoffs.

Best regards,  
[Your name]
