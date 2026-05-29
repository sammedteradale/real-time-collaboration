import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Brush,
  Circle,
  Clock3,
  Download,
  Eraser,
  FileText,
  MousePointer2,
  PenLine,
  RefreshCcw,
  Redo2,
  Sparkles,
  Trash2,
  Undo2,
  Users,
  Wifi,
  WifiOff
} from 'lucide-react';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws';

function send(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function useCollaboration() {
  const wsRef = useRef(null);
  const [client, setClient] = useState(null);
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState(() => localStorage.getItem('collab-name') || '');
  const [roomId, setRoomId] = useState(() => localStorage.getItem('collab-room') || 'main-room');
  const [documentText, setDocumentText] = useState('');
  const [strokes, setStrokes] = useState([]);
  const [presence, setPresence] = useState([]);
  const [activity, setActivity] = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({});

  useEffect(() => {
    let reconnectTimer;

    function connect() {
      const socket = new WebSocket(WS_URL);
      wsRef.current = socket;

      socket.addEventListener('open', () => {
        setConnected(true);
        send(socket, { type: 'join', name: name || 'Guest', roomId });
      });

      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'init') {
          setClient(message.client);
          setDocumentText(message.state.documentText);
          setStrokes(message.state.strokes || []);
          setPresence(message.presence || []);
          setActivity(message.state.activity || []);
        }

        if (message.type === 'presence') {
          setPresence(message.presence || []);
          setActivity(message.activity || []);
        }

        if (message.type === 'document:update') {
          setDocumentText(message.text);
          setActivity(message.activity || []);
        }

        if (message.type === 'stroke:add') {
          setStrokes((current) => [...current, message.stroke]);
          setActivity(message.activity || []);
        }

        if (message.type === 'whiteboard:clear') {
          setStrokes([]);
          setActivity(message.activity || []);
        }

        if (message.type === 'whiteboard:replace') {
          setStrokes(message.strokes || []);
          setActivity(message.activity || []);
        }

        if (message.type === 'cursor:move') {
          setRemoteCursors((current) => ({
            ...current,
            [message.cursor.userId]: { ...message.cursor, seenAt: Date.now() }
          }));
        }
      });

      socket.addEventListener('close', () => {
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 1200);
      });
    }

    connect();

    return () => {
      window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRemoteCursors((current) => {
        const fresh = {};
        for (const [id, cursor] of Object.entries(current)) {
          if (Date.now() - cursor.seenAt < 2500) fresh[id] = cursor;
        }
        return fresh;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  function updateName(nextName) {
    const cleanName = nextName.slice(0, 24);
    setName(cleanName);
    localStorage.setItem('collab-name', cleanName);
    send(wsRef.current, { type: 'join', name: cleanName || 'Guest', roomId });
  }

  function updateRoom(nextRoomId) {
    const cleanRoomId = nextRoomId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 32) || 'main-room';
    setRoomId(cleanRoomId);
    localStorage.setItem('collab-room', cleanRoomId);
    send(wsRef.current, { type: 'join', name: name || 'Guest', roomId: cleanRoomId });
  }

  function updateDocument(nextText) {
    setDocumentText(nextText);
    send(wsRef.current, { type: 'document:update', text: nextText });
  }

  function addStroke(stroke) {
    setStrokes((current) => [...current, stroke]);
    send(wsRef.current, { type: 'stroke:add', stroke });
  }

  function clearWhiteboard() {
    setStrokes([]);
    send(wsRef.current, { type: 'whiteboard:clear' });
  }

  function undoWhiteboard() {
    send(wsRef.current, { type: 'whiteboard:undo' });
  }

  function redoWhiteboard() {
    send(wsRef.current, { type: 'whiteboard:redo' });
  }

  function moveCursor(x, y) {
    send(wsRef.current, { type: 'cursor:move', x, y });
  }

  return {
    client,
    connected,
    name,
    roomId,
    documentText,
    strokes,
    presence,
    activity,
    remoteCursors,
    updateName,
    updateRoom,
    updateDocument,
    addStroke,
    clearWhiteboard,
    undoWhiteboard,
    redoWhiteboard,
    moveCursor
  };
}

function Whiteboard({
  strokes,
  addStroke,
  clearWhiteboard,
  undoWhiteboard,
  redoWhiteboard,
  moveCursor,
  remoteCursors
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef(null);
  const [tool, setTool] = useState('draw');
  const [color, setColor] = useState('#2563eb');
  const [size, setSize] = useState(5);

  const palette = ['#2563eb', '#0f766e', '#b42318', '#7c3aed', '#111827', '#f59e0b'];

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    for (const stroke of strokes) {
      drawStroke(context, stroke);
    }
  }, [strokes]);

  function pointFromEvent(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    const pointer = event.touches?.[0] || event;
    return {
      x: pointer.clientX - rect.left,
      y: pointer.clientY - rect.top
    };
  }

  function drawStroke(context, stroke) {
    if (stroke.points.length < 2) return;
    context.save();
    context.globalCompositeOperation =
      stroke.mode === 'erase' ? 'destination-out' : 'source-over';
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.size;
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    stroke.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.stroke();
    context.restore();
  }

  function startDrawing(event) {
    event.preventDefault();
    drawingRef.current = true;
    const point = pointFromEvent(event);
    currentStrokeRef.current = {
      color,
      size,
      mode: tool === 'erase' ? 'erase' : 'draw',
      points: [point]
    };
  }

  function continueDrawing(event) {
    const point = pointFromEvent(event);
    moveCursor(point.x, point.y);

    if (!drawingRef.current) return;
    const stroke = currentStrokeRef.current;
    stroke.points.push(point);

    const context = canvasRef.current.getContext('2d');
    drawStroke(context, stroke);
  }

  function stopDrawing() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    if (stroke.points.length > 1) addStroke(stroke);
  }

  return (
    <section className="workspace-panel whiteboard-panel">
      <div className="panel-title-row">
        <div>
          <h2>Whiteboard</h2>
          <span>Sketch flows, boxes, and quick ideas</span>
        </div>
        <div className="panel-actions">
          <span className="board-count">
            <PenLine size={14} />
            {strokes.length}
          </span>
          <button className="icon-button" type="button" onClick={undoWhiteboard} title="Undo stroke">
            <Undo2 size={18} />
          </button>
          <button className="icon-button" type="button" onClick={redoWhiteboard} title="Redo stroke">
            <Redo2 size={18} />
          </button>
          <button
            className="icon-button danger"
            type="button"
            onClick={clearWhiteboard}
            title="Clear board"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      <div className="toolbar">
        <button
          className={tool === 'draw' ? 'tool active' : 'tool'}
          type="button"
          onClick={() => setTool('draw')}
          title="Pen"
        >
          <Brush size={18} />
        </button>
        <button
          className={tool === 'erase' ? 'tool active' : 'tool'}
          type="button"
          onClick={() => setTool('erase')}
          title="Eraser"
        >
          <Eraser size={18} />
        </button>
        <div className="swatches">
          {palette.map((item) => (
            <button
              className={color === item ? 'swatch selected' : 'swatch'}
              key={item}
              onClick={() => setColor(item)}
              style={{ background: item }}
              title={item}
              type="button"
            />
          ))}
        </div>
        <label className="size-control">
          <Circle size={15} />
          <input
            min="2"
            max="18"
            type="range"
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="board-shell">
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={continueDrawing}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={continueDrawing}
          onTouchEnd={stopDrawing}
        />
        {Object.values(remoteCursors).map((cursor) => (
          <div
            className="remote-cursor"
            key={cursor.userId}
            style={{ left: cursor.x, top: cursor.y, color: cursor.color }}
          >
            <MousePointer2 size={18} fill="currentColor" />
            <span style={{ background: cursor.color }}>{cursor.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function App() {
  const collaboration = useCollaboration();
  const [draftRoomId, setDraftRoomId] = useState(collaboration.roomId);
  const wordCount = useMemo(() => {
    const words = collaboration.documentText.trim().split(/\s+/).filter(Boolean);
    return words.length;
  }, [collaboration.documentText]);
  const activeNow = collaboration.presence.length;
  const initials = useMemo(() => {
    return (collaboration.name || 'Guest')
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }, [collaboration.name]);

  useEffect(() => {
    setDraftRoomId(collaboration.roomId);
  }, [collaboration.roomId]);

  function joinRoom(event) {
    event.preventDefault();
    collaboration.updateRoom(draftRoomId);
  }

  function downloadDocument() {
    const roomName = collaboration.roomId || 'main-room';
    const blob = new Blob([collaboration.documentText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${roomName}-document.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={21} />
          </div>
          <div>
            <h1>CollabSpace</h1>
            <p>Real-time team room</p>
          </div>
        </div>

        <label className="name-field">
          <span>Your name</span>
          <input
            value={collaboration.name}
            placeholder="Enter your name"
            onChange={(event) => collaboration.updateName(event.target.value)}
          />
        </label>

        <form className="room-form" onSubmit={joinRoom}>
          <label>
            <span>Room code</span>
            <input
              value={draftRoomId}
              placeholder="main-room"
              onChange={(event) => setDraftRoomId(event.target.value)}
            />
          </label>
          <button type="submit">Join</button>
        </form>

        <div className={collaboration.connected ? 'status online' : 'status offline'}>
          {collaboration.connected ? <Wifi size={17} /> : <WifiOff size={17} />}
          <span>{collaboration.connected ? 'Live sync connected' : 'Reconnecting'}</span>
        </div>

        <div className="room-card">
          <div>
            <span>Room</span>
            <strong>{collaboration.roomId}</strong>
          </div>
          <code>LIVE</code>
        </div>

        <div className="sidebar-stats">
          <div>
            <strong>{activeNow}</strong>
            <span>online</span>
          </div>
          <div>
            <strong>{wordCount}</strong>
            <span>words</span>
          </div>
          <div>
            <strong>{collaboration.strokes.length}</strong>
            <span>strokes</span>
          </div>
        </div>

        <section className="sidebar-section">
          <h2>
            <Users size={17} />
            People
          </h2>
          <div className="people-list">
            {collaboration.presence.map((person) => (
              <div className="person" key={person.id}>
                <span className="avatar" style={{ background: person.color }}>
                  {person.name.slice(0, 1).toUpperCase()}
                </span>
                <span>{person.name}</span>
                <small>editing</small>
              </div>
            ))}
          </div>
        </section>

        <section className="sidebar-section">
          <h2>
            <RefreshCcw size={17} />
            Activity
          </h2>
          <div className="activity-list">
            {collaboration.activity.length === 0 && <p>No activity yet</p>}
            {collaboration.activity.map((item) => (
              <p key={item.id}>
                <Clock3 size={13} />
                <span>{item.message}</span>
              </p>
            ))}
          </div>
        </section>
      </aside>

      <section className="main-area">
        <header className="topbar workspace-hero">
          <div className="topbar-copy">
            <span className="eyebrow">Live room</span>
            <h2>Creative Sync Studio</h2>
            <p>{collaboration.roomId} is open for shared notes, sketches, and decisions.</p>
            <div className="hero-metrics">
              <span>
                <Users size={15} />
                {activeNow} online
              </span>
              <span>
                <FileText size={15} />
                {wordCount} words
              </span>
              <span>
                <PenLine size={15} />
                {collaboration.strokes.length} strokes
              </span>
            </div>
          </div>
          <div className="self-chip">
            <span>{initials}</span>
            <strong>{collaboration.name || 'Guest'}</strong>
          </div>
        </header>

        <div className="workspace-grid">
          <section className="workspace-panel document-panel">
            <div className="panel-title-row">
              <div>
                <h2>Document</h2>
                <span>Draft notes, plans, and shared decisions</span>
              </div>
              <div className="panel-actions">
                <button
                  className="icon-button"
                  type="button"
                  onClick={downloadDocument}
                  title="Download document"
                >
                  <Download size={18} />
                </button>
                <FileText size={21} />
              </div>
            </div>
            <textarea
              value={collaboration.documentText}
              onChange={(event) => collaboration.updateDocument(event.target.value)}
              spellCheck="true"
            />
            <div className="document-footer">
              <span>{wordCount} words</span>
              <span>{collaboration.documentText.length} characters</span>
              <span>{collaboration.connected ? 'Synced' : 'Waiting for server'}</span>
            </div>
          </section>

          <Whiteboard
            strokes={collaboration.strokes}
            addStroke={collaboration.addStroke}
            clearWhiteboard={collaboration.clearWhiteboard}
            undoWhiteboard={collaboration.undoWhiteboard}
            redoWhiteboard={collaboration.redoWhiteboard}
            moveCursor={collaboration.moveCursor}
            remoteCursors={collaboration.remoteCursors}
          />
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
