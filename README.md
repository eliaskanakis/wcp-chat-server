# WCP Chat Server

Node.js WebSocket service for the WRH Coordination Platform. It authenticates clients with Firebase ID tokens, enforces Firestore-defined channel rules, persists chat history, and relays WebRTC signaling.

## Related Repositories
- Frontend UI: https://github.com/eliaskanakis/wcp-frontend (live: https://wrh-coord-platform.web.app/)
- Speech-to-text service: https://github.com/eliaskanakis/wcp-stt-server

## Local Development
```bash
npm install
FIREBASE_SERVICE_ACCOUNT=<JSON or base64>
npm start
```
The WebSocket server listens on `PORT` (default 4000). Supported message types include `join`, `chat`, `fetch-history`, `ping`, `webrtc-*`, and `call-*`.

## Deployment
`deploy.ps1` holds a reference Cloud Run deployment command that expects an `.env-yaml` file containing your Firebase credentials (JSON encoded as base64).

## Demo
YouTube placeholder: https://www.youtube.com/watch?v=nZzlvX0EO1A
