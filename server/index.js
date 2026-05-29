import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import mongoose from 'mongoose';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const DEFAULT_ROOM_ID = 'main-room';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

const workspaceSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true },
    documentText: { type: String, default: '' },
    strokes: { type: Array, default: [] },
    activity: { type: Array, default: [] }
  },
  { timestamps: true }
);

const Workspace = mongoose.model('Workspace', workspaceSchema);

let mongoReady = false;
const rooms = new Map();

const clients = new Map();
const colors = ['#0f766e', '#b42318', '#2563eb', '#7c3aed', '#b45309', '#be123c'];

function createDefaultState(roomId) {
  return {
    roomId,
    documentText:
      'Welcome to CollabSpace.\n\nOpen this room in another browser window and start typing or drawing. Everyone sees updates instantly.',
    strokes: [],
    undoneStrokes: [],
    activity: []
  };
}

function cleanRoomId(roomId) {
  return String(roomId || DEFAULT_ROOM_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32) || DEFAULT_ROOM_ID;
}

async function connectDatabase() {
  if (!process.env.MONGODB_URI) return;

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    mongoReady = true;
    const defaultState = createDefaultState(DEFAULT_ROOM_ID);
    const workspace = await Workspace.findOneAndUpdate(
      { roomId: DEFAULT_ROOM_ID },
      { $setOnInsert: defaultState },
      { upsert: true, new: true }
    ).lean();

    rooms.set(DEFAULT_ROOM_ID, {
      roomId: workspace.roomId,
      documentText: workspace.documentText,
      strokes: workspace.strokes,
      undoneStrokes: [],
      activity: workspace.activity || []
    });

    console.log('MongoDB connected');
  } catch (error) {
    console.warn('MongoDB unavailable. Running with in-memory state.');
    console.warn(error.message);
  }
}

async function loadRoom(roomId) {
  const cleanId = cleanRoomId(roomId);
  if (rooms.has(cleanId)) return rooms.get(cleanId);

  if (mongoReady) {
    const defaultState = createDefaultState(cleanId);
    const workspace = await Workspace.findOneAndUpdate(
      { roomId: cleanId },
      { $setOnInsert: defaultState },
      { upsert: true, new: true }
    ).lean();

    const state = {
      roomId: workspace.roomId,
      documentText: workspace.documentText,
      strokes: workspace.strokes || [],
      undoneStrokes: [],
      activity: workspace.activity || []
    };
    rooms.set(cleanId, state);
    return state;
  }

  const state = createDefaultState(cleanId);
  rooms.set(cleanId, state);
  return state;
}

async function persistState(state) {
  if (!mongoReady) return;

  await Workspace.updateOne(
    { roomId: state.roomId },
    {
      $set: {
        documentText: state.documentText,
        strokes: state.strokes,
        activity: state.activity
      }
    },
    { upsert: true }
  );
}

function addActivity(state, message) {
  state.activity = [
    { id: randomUUID(), message, time: new Date().toISOString() },
    ...state.activity
  ].slice(0, 12);
}

function safeSend(connection, payload) {
  const socket = connection.ws || connection;
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcast(roomId, payload, exceptId = null) {
  for (const [clientId, client] of clients) {
    if (clientId !== exceptId && client.roomId === roomId) safeSend(client.ws, payload);
  }
}

function presence(roomId) {
  return [...clients.values()]
    .filter((client) => client.roomId === roomId)
    .map((client) => ({
      id: client.id,
      name: client.name,
      color: client.color
    }));
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    persistence: mongoReady ? 'mongodb' : 'memory',
    users: clients.size,
    rooms: rooms.size
  });
});

app.get('/api/workspace', async (_req, res) => {
  const state = await loadRoom(DEFAULT_ROOM_ID);
  res.json(state);
});

app.get('/api/workspace/:roomId', async (req, res) => {
  const state = await loadRoom(req.params.roomId);
  res.json(state);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const id = randomUUID();
  const color = colors[clients.size % colors.length];
  const client = { id, ws, name: 'Guest', color, roomId: DEFAULT_ROOM_ID };
  clients.set(id, client);

  loadRoom(DEFAULT_ROOM_ID).then((state) => safeSend(client, {
    type: 'init',
    client: { id, color },
    state,
    presence: presence(DEFAULT_ROOM_ID)
  }));

  ws.on('message', async (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    if (message.type === 'join') {
      client.name = String(message.name || 'Guest').slice(0, 24);
      const previousRoomId = client.roomId;
      const nextRoomId = cleanRoomId(message.roomId);

      if (previousRoomId !== nextRoomId) {
        const previousState = await loadRoom(previousRoomId);
        addActivity(previousState, `${client.name} left the room`);
        broadcast(previousRoomId, {
          type: 'presence',
          presence: presence(previousRoomId),
          activity: previousState.activity
        });
        await persistState(previousState);
      }

      client.roomId = nextRoomId;
      const state = await loadRoom(nextRoomId);
      addActivity(state, `${client.name} joined the room`);
      safeSend(client, {
        type: 'init',
        client: { id, color: client.color },
        state,
        presence: presence(nextRoomId)
      });
      broadcast(nextRoomId, {
        type: 'presence',
        presence: presence(nextRoomId),
        activity: state.activity
      });
      await persistState(state);
      return;
    }

    if (message.type === 'document:update') {
      const state = await loadRoom(client.roomId);
      state.documentText = String(message.text || '');
      addActivity(state, `${client.name} updated the document`);
      broadcast(
        client.roomId,
        { type: 'document:update', text: state.documentText, activity: state.activity },
        id
      );
      await persistState(state);
      return;
    }

    if (message.type === 'stroke:add') {
      const state = await loadRoom(client.roomId);
      const stroke = {
        id: randomUUID(),
        userId: id,
        userName: client.name,
        color: message.stroke?.color || client.color,
        size: Number(message.stroke?.size || 4),
        mode: message.stroke?.mode === 'erase' ? 'erase' : 'draw',
        points: Array.isArray(message.stroke?.points) ? message.stroke.points : []
      };

      state.strokes = [...state.strokes, stroke].slice(-700);
      state.undoneStrokes = [];
      addActivity(state, `${client.name} drew on the whiteboard`);
      broadcast(client.roomId, { type: 'stroke:add', stroke, activity: state.activity }, id);
      await persistState(state);
      return;
    }

    if (message.type === 'whiteboard:undo') {
      const state = await loadRoom(client.roomId);
      const stroke = state.strokes.pop();
      if (!stroke) return;
      state.undoneStrokes = [stroke, ...(state.undoneStrokes || [])].slice(0, 100);
      addActivity(state, `${client.name} undid a whiteboard stroke`);
      broadcast(client.roomId, {
        type: 'whiteboard:replace',
        strokes: state.strokes,
        activity: state.activity
      });
      await persistState(state);
      return;
    }

    if (message.type === 'whiteboard:redo') {
      const state = await loadRoom(client.roomId);
      const stroke = state.undoneStrokes?.shift();
      if (!stroke) return;
      state.strokes = [...state.strokes, stroke].slice(-700);
      addActivity(state, `${client.name} redid a whiteboard stroke`);
      broadcast(client.roomId, {
        type: 'whiteboard:replace',
        strokes: state.strokes,
        activity: state.activity
      });
      await persistState(state);
      return;
    }

    if (message.type === 'whiteboard:clear') {
      const state = await loadRoom(client.roomId);
      state.strokes = [];
      state.undoneStrokes = [];
      addActivity(state, `${client.name} cleared the whiteboard`);
      broadcast(client.roomId, { type: 'whiteboard:clear', activity: state.activity }, id);
      await persistState(state);
      return;
    }

    if (message.type === 'cursor:move') {
      broadcast(
        client.roomId,
        {
          type: 'cursor:move',
          cursor: {
            userId: id,
            name: client.name,
            color: client.color,
            x: message.x,
            y: message.y
          }
        },
        id
      );
    }
  });

  ws.on('close', () => {
    const name = client.name;
    const roomId = client.roomId;
    clients.delete(id);
    loadRoom(roomId).then((state) => {
      addActivity(state, `${name} left the room`);
      broadcast(roomId, { type: 'presence', presence: presence(roomId), activity: state.activity });
      persistState(state);
    });
  });
});

if (process.env.NODE_ENV === 'production') {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const distPath = path.join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

await connectDatabase();

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
