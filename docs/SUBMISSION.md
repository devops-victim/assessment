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

The dashboard starts empty and accepts a report job immediately with HTTP 202 and a job ID. After the full 15-minute generation, a small WebSocket completion event supplies a download URL; the browser downloads the 2,000-record report over HTTP and updates automatically. Later visits show saved reports immediately. There is no page refresh, HTTP polling or cron job. The 30-second socket cutoff is enforced and visibly demonstrated; subscriptions renew before it while the durable job continues.

The architecture note explains the async exchange handshake needed to respect the 30-second connection limit, persistence, reconnect/restart recovery, and implementation tradeoffs.

Best regards,  
[Your name]
