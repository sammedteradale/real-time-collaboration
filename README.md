# CollabSpace - MERN Real-Time Collaboration Tool

CollabSpace is a live multi-user collaboration workspace built with MongoDB, Express, React, Node.js, and WebSocket.

## Features

- Shared document editor synced live across users
- Shared whiteboard with pen, eraser, color, size, and clear controls
- Multi-user presence list
- Activity feed for joins, edits, drawing, and clears
- MongoDB persistence when `MONGODB_URI` is available
- In-memory fallback for quick demos

## Run Locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173` in two browser windows to test real-time sync.

The API/WebSocket server runs on `http://localhost:5000`.
