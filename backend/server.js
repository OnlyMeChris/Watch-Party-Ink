/**
 * WatchInk Beta — Sync Server
 * Node.js + WebSocket (ws library)
 *
 * Responsibilities:
 *   - Room lifecycle: create, join, leave, expire
 *   - Broadcast playback events: play, pause, seek, time_sync, next_episode
 *   - Host authority: only host's events are broadcast
 *   - Host transfer if host disconnects
 *   - Ping/pong latency measurement
 *   - Room expiration after inactivity
 */

'use strict';

const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const http = require('http');

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3001,
  ROOM_EXPIRY_MS: 4 * 60 * 60 * 1000,     // 4 hours
  ROOM_CLEANUP_INTERVAL: 10 * 60 * 1000,   // Check every 10 min
  MAX_USERS_PER_ROOM: 20,
  HEARTBEAT_INTERVAL: 30000,               // 30s ping to detect dead connections
};

// ─── Room Store ───────────────────────────────────────────────────────────────
// rooms: Map<roomId, Room>
// Room = { id, hostUsername, users: Map<username, ClientInfo>, createdAt, lastActivity }
// ClientInfo = { ws, username, isHost, joinedAt }

const rooms = new Map();

class Room {
  constructor(id, hostUsername) {
    this.id = id;
    this.hostUsername = hostUsername;
    this.users = new Map();               // username → { ws, username, isHost, isReady }
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.lastHostTime = 0;               // Last known host currentTime
    this.lastHostTimeAt = Date.now();    // When that was recorded
    this.currentUrl = null;              // Current movie/episode URL
  }

  getUserList() {
    return Array.from(this.users.values()).map(u => ({
      username: u.username,
      isHost: u.isHost,
      isReady: u.isReady ?? true,        // Assume ready unless marked otherwise
    }));
  }
  
  getReadyUserList() {
    return Array.from(this.users.values()).filter(u => u.isReady !== false);
  }
  
  areAllGuestsReady() {
    // Host is always ready, check if all non-host users are ready
    for (const user of this.users.values()) {
      if (!user.isHost && user.isReady === false) {
        return false;
      }
    }
    return true;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  isExpired() {
    return Date.now() - this.lastActivity > CONFIG.ROOM_EXPIRY_MS;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('[WatchInk] Send error:', e.message);
    }
  }
}

function broadcast(room, data, excludeUsername = null) {
  for (const [username, client] of room.users) {
    if (username !== excludeUsername) {
      send(client.ws, data);
    }
  }
}

function broadcastAll(room, data) {
  for (const client of room.users.values()) {
    send(client.ws, data);
  }
}

// Validate event data to prevent malformed inputs
function validateEventData(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.event !== 'string') return false;
  if (data.roomId && typeof data.roomId !== 'string') return false;
  if (data.currentTime !== undefined && (typeof data.currentTime !== 'number' || !isFinite(data.currentTime))) return false;
  return true;
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

function handleCreateRoom(ws, data) {
  const { roomId, username } = data;

  if (!roomId || !username || typeof roomId !== 'string' || typeof username !== 'string') {
    return send(ws, { event: 'room_error', message: 'Invalid room data' });
  }

  if (rooms.has(roomId)) {
    return send(ws, { event: 'room_error', message: 'Room already exists. Try a different code.' });
  }

  const room = new Room(roomId, username);
  room.users.set(username, { ws, username, isHost: true });
  rooms.set(roomId, room);

  // Tag the socket for cleanup
  ws._watchink = { roomId, username };

  send(ws, {
    event: 'room_created',
    roomId,
    users: room.getUserList(),
  });

  console.log(`[WatchInk] Room created: ${roomId} by ${username}`);
}

function handleJoinRoom(ws, data) {
  const { roomId, username } = data;

  if (!roomId || !username) {
    return send(ws, { event: 'room_error', message: 'Missing room ID or username' });
  }

  const room = rooms.get(roomId?.toUpperCase());
  if (!room) {
    return send(ws, { event: 'room_error', message: 'Room not found. Check the code and try again.' });
  }

  if (room.users.size >= CONFIG.MAX_USERS_PER_ROOM) {
    return send(ws, { event: 'room_error', message: 'Room is full (max 20 users).' });
  }

  if (room.users.has(username)) {
    // Re-join (reconnect scenario) — update socket
    const existing = room.users.get(username);
    existing.ws = ws;
    existing.isReady = false;  // Mark as not ready when reconnecting
    ws._watchink = { roomId, username };
    room.touch();
    send(ws, {
      event: 'room_joined',
      roomId,
      users: room.getUserList(),
      currentUrl: room.currentUrl,
    });
    broadcast(room, { event: 'users_updated', users: room.getUserList() }, username);
    
    // Notify host of guest status change
    if (!existing.isHost) {
      const hostUser = Array.from(room.users.values()).find(u => u.isHost);
      if (hostUser) {
        send(hostUser.ws, {
          event: 'guests_ready_status',
          allReady: room.areAllGuestsReady(),
          users: room.getUserList(),
        });
      }
    }
    
    console.log(`[WatchInk] ${username} reconnected to room ${roomId}`);
    return;
  }

  room.users.set(username, { ws, username, isHost: false, isReady: false });
  ws._watchink = { roomId, username };
  room.touch();

  send(ws, {
    event: 'room_joined',
    roomId,
    users: room.getUserList(),
    currentUrl: room.currentUrl,        // Send current URL to joining user
  });

  // Tell everyone else
  broadcast(room, { event: 'users_updated', users: room.getUserList() }, username);
  
  // Notify host that a guest is loading
  const hostUser = Array.from(room.users.values()).find(u => u.isHost);
  if (hostUser) {
    send(hostUser.ws, {
      event: 'guests_ready_status',
      allReady: room.areAllGuestsReady(),
      users: room.getUserList(),
    });
  }

  console.log(`[WatchInk] ${username} joined room ${roomId} (${room.users.size} total)`);
}

function handleLeaveRoom(ws, data) {
  const roomId = data?.roomId || ws._watchink?.roomId;
  const username = data?.username || ws._watchink?.username;
  if (!roomId || !username) return;

  const room = rooms.get(roomId);
  if (!room) return;

  removeUserFromRoom(room, roomId, username);
}

function removeUserFromRoom(room, roomId, username) {
  if (!room.users.has(username)) return;

  const wasHost = room.users.get(username)?.isHost;
  room.users.delete(username);
  room.touch();

  console.log(`[WatchInk] ${username} left room ${roomId} (${room.users.size} remaining)`);

  if (room.users.size === 0) {
    // Empty room — delete it
    rooms.delete(roomId);
    console.log(`[WatchInk] Room ${roomId} deleted (empty)`);
    return;
  }

  if (wasHost && room.users.size > 0) {
    // Transfer host to next user
    const newHostEntry = room.users.values().next().value;
    newHostEntry.isHost = true;
    room.hostUsername = newHostEntry.username;

    broadcastAll(room, {
      event: 'host_transferred',
      newHostUsername: newHostEntry.username,
      users: room.getUserList(),
    });

    console.log(`[WatchInk] Host transferred to ${newHostEntry.username} in room ${roomId}`);
  } else {
    broadcastAll(room, {
      event: 'users_updated',
      users: room.getUserList(),
    });
  }
}

function handlePlay(ws, data) {
  const room = getRoomForClient(ws, data);
  if (!room) return;
  if (!isHost(room, ws)) return;  // Only host can broadcast play

  if (data.currentUrl) {
    room.currentUrl = data.currentUrl;
  }
  
  room.touch();
  broadcast(room, {
    event: 'sync_play',
    currentTime: data.currentTime ?? 0,
    currentUrl: room.currentUrl,
  }, ws._watchink?.username);
}

function handlePause(ws, data) {
  const room = getRoomForClient(ws, data);
  if (!room) return;
  if (!isHost(room, ws)) return;

  if (data.currentUrl) {
    room.currentUrl = data.currentUrl;
  }

  room.touch();
  broadcast(room, {
    event: 'sync_pause',
    currentTime: data.currentTime ?? 0,
    currentUrl: room.currentUrl,
  }, ws._watchink?.username);
}

function handleSeek(ws, data) {
  const room = getRoomForClient(ws, data);
  if (!room) return;
  if (!isHost(room, ws)) return;

  if (data.currentUrl) {
    room.currentUrl = data.currentUrl;
  }

  room.touch();
  broadcast(room, {
    event: 'sync_seek',
    currentTime: data.currentTime ?? 0,
    currentUrl: room.currentUrl,
  }, ws._watchink?.username);
}

function handleTimeSync(ws, data) {
  const room = getRoomForClient(ws, data);
  if (!room) return;
  if (!isHost(room, ws)) return;

  // Store host's current time for resync requests
  room.lastHostTime = data.currentTime ?? 0;
  room.lastHostTimeAt = Date.now();
  
  // Track URL if provided
  if (data.currentUrl) {
    room.currentUrl = data.currentUrl;
  }

  broadcast(room, {
    event: 'sync_time',
    currentTime: data.currentTime ?? 0,
    currentUrl: room.currentUrl,        // Send URL with time sync
  }, ws._watchink?.username);
}

function handleNextEpisode(ws, data) {
  const room = getRoomForClient(ws, data);
  if (!room) return;
  if (!isHost(room, ws)) return;

  if (!data.targetUrl || typeof data.targetUrl !== 'string') return;
  // Security: only allow disneyplus.com URLs
  if (!data.targetUrl.startsWith('https://www.disneyplus.com') && !data.targetUrl.startsWith('https://disneyplus.com')) {
    console.warn('[WatchInk] Blocked non-Disney+ URL:', data.targetUrl);
    return;
  }

  room.touch();
  broadcast(room, {
    event: 'sync_next_episode',
    targetUrl: data.targetUrl,
    currentTime: data.currentTime ?? 0,
  }, ws._watchink?.username);

  console.log(`[WatchInk] Next episode sync in room ${room.id}: ${data.targetUrl}`);
}

function handleResyncRequest(ws, data) {
  const room = getRoomForClient(ws, data);
  if (!room) return;

  // Respond with last known host time (adjusted for elapsed time)
  const elapsed = (Date.now() - room.lastHostTimeAt) / 1000;
  const estimatedTime = room.lastHostTime + elapsed;

  send(ws, {
    event: 'resync_response',
    currentTime: estimatedTime,
  });
}

function handlePing(ws, data) {
  send(ws, { event: 'pong' });
}

function handleGuestReady(ws, data) {
  const room = getRoomForClient(ws, data);
  if (!room) return;
  
  const username = ws._watchink?.username;
  if (!username) return;
  
  const user = room.users.get(username);
  if (user && !user.isHost) {
    // Mark guest as ready
    user.isReady = true;
    room.touch();
    
    // Notify host of updated guest status
    const hostUser = Array.from(room.users.values()).find(u => u.isHost);
    if (hostUser) {
      send(hostUser.ws, {
        event: 'guests_ready_status',
        allReady: room.areAllGuestsReady(),
        users: room.getUserList(),
      });
    }
    
    console.log(`[WatchInk] ${username} ready in room ${room.id} (all ready: ${room.areAllGuestsReady()})`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRoomForClient(ws, data) {
  const roomId = data?.roomId || ws._watchink?.roomId;
  if (!roomId) return null;
  return rooms.get(roomId) || null;
}

function isHost(room, ws) {
  const username = ws._watchink?.username;
  if (!username) return false;
  const user = room.users.get(username);
  return user?.isHost === true;
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

// Create an HTTP server too (for health checks on Replit)
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      uptime: process.uptime(),
      version: '1.0.0',
    }));
  } else if (req.url === '/rooms') {
    // Debug endpoint — room stats only (no user data)
    const roomData = [];
    for (const [id, room] of rooms) {
      roomData.push({ id, users: room.users.size, host: room.hostUsername });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rooms: roomData }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>WatchInk Server</title>
      <style>
        body { font-family: system-ui; max-width: 600px; margin: 60px auto; padding: 0 20px; }
        h1 { color: #E5173F; } pre { background: #f5f5f5; padding: 16px; border-radius: 8px; }
      </style>
      </head>
      <body>
        <h1>🎬 WatchInk Beta Server</h1>
        <p>WebSocket sync server for Disney+ watch parties.</p>
        <pre>Active Rooms: ${rooms.size}
Uptime: ${Math.floor(process.uptime())}s
Status: Running ✓</pre>
        <p><a href="/health">/health</a> · <a href="/rooms">/rooms</a></p>
      </body>
      </html>
    `);
  }
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WatchInk] New connection from ${ip}`);

  ws._watchink = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const data = safeParseJSON(raw.toString());

    if (!validateEventData(data)) {
      console.warn('[WatchInk] Invalid event data received, ignoring');
      return;
    }

    switch (data.event) {
      case 'create_room':    handleCreateRoom(ws, data); break;
      case 'join_room':      handleJoinRoom(ws, data); break;
      case 'leave_room':     handleLeaveRoom(ws, data); break;
      case 'play':           handlePlay(ws, data); break;
      case 'pause':          handlePause(ws, data); break;
      case 'seek':           handleSeek(ws, data); break;
      case 'time_sync':      handleTimeSync(ws, data); break;
      case 'next_episode':   handleNextEpisode(ws, data); break;
      case 'request_resync': handleResyncRequest(ws, data); break;
      case 'guest_ready':    handleGuestReady(ws, data); break;
      case 'ping':           handlePing(ws, data); break;
      case 'keepalive':      break; // No-op, just keeps connection alive
      default:
        console.log('[WatchInk] Unknown event:', data.event);
    }
  });

  ws.on('close', () => {
    if (ws._watchink) {
      const { roomId, username } = ws._watchink;
      const room = rooms.get(roomId);
      if (room) {
        // Small delay to allow reconnect before removing
        setTimeout(() => {
          // Only remove if they haven't reconnected (socket would be replaced)
          const user = room.users.get(username);
          if (user && user.ws === ws) {
            removeUserFromRoom(room, roomId, username);
          }
        }, 5000);
      }
    }
    console.log('[WatchInk] Connection closed');
  });

  ws.on('error', (err) => {
    console.error('[WatchInk] Socket error:', err.message);
  });
});

// ─── Heartbeat (detect dead connections) ──────────────────────────────────────
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, CONFIG.HEARTBEAT_INTERVAL);

// ─── Room Expiration Cleanup ───────────────────────────────────────────────────
setInterval(() => {
  let cleaned = 0;
  for (const [roomId, room] of rooms) {
    if (room.isExpired()) {
      // Notify remaining users
      broadcastAll(room, { event: 'room_expired' });
      rooms.delete(roomId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[WatchInk] Cleaned up ${cleaned} expired room(s)`);
  }
}, CONFIG.ROOM_CLEANUP_INTERVAL);

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   🎬  WatchInk Beta Server           ║
║   Port: ${CONFIG.PORT}                         ║
║   WebSocket + HTTP ready             ║
║   Health: http://localhost:${CONFIG.PORT}/health ║
╚══════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[WatchInk] Shutting down gracefully...');
  for (const room of rooms.values()) {
    broadcastAll(room, { event: 'room_expired' });
  }
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
});
