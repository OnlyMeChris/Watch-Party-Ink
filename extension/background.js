/**
 * WatchInk Beta — Background Service Worker (Manifest V3)
 * Manages the WebSocket connection to the sync server.
 * Acts as a relay between content scripts and the socket.
 *
 * Architecture:
 *   Content Script ←→ chrome.runtime.sendMessage ←→ Background ←→ WebSocket Server
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let ws = null;
let isConnected = false;
let reconnectTimer = null;
let serverUrl = 'ws://localhost:3001';
let pendingRoom = null;  // For re-joining after reconnect
let activeTabId = null;

// ─── Tab tracking ─────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(info => { activeTabId = info.tabId; });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') activeTabId = tabId;
});

// ─── Relay message to content script ─────────────────────────────────────────
async function sendToContent(data) {
  try {
    // Find Disney+ tabs
    const tabs = await chrome.tabs.query({
      url: ['https://*.disneyplus.com/*', 'https://*.apps.disneyplus.com/*']
    });
    console.log('[WatchInk BG] Sending to', tabs.length, 'tabs:', data.type);
    for (const tab of tabs) {
      console.log('[WatchInk BG] Sending to tab', tab.id, 'message:', data.type);
      chrome.tabs.sendMessage(tab.id, data).catch((err) => {
        console.warn('[WatchInk BG] Send to tab failed:', err.message);
      });
    }
  } catch (e) {
    console.error('[WatchInk BG] sendToContent error:', e);
  }
}

// ─── WebSocket Connection ─────────────────────────────────────────────────────
function connectWebSocket(url) {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  serverUrl = url || serverUrl;

  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    console.error('[WatchInk BG] WebSocket connection failed:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnected = true;
    clearTimeout(reconnectTimer);
    console.log('[WatchInk BG] WebSocket connected');
    sendToContent({ type: 'SOCKET_CONNECTED' });

    // Re-join room if we were in one
    if (pendingRoom) {
      send({
        event: pendingRoom.isHost ? 'create_room' : 'join_room',
        ...pendingRoom,
      });
      pendingRoom = null;
    }
  };

  ws.onclose = () => {
    isConnected = false;
    console.log('[WatchInk BG] WebSocket closed');
    sendToContent({ type: 'SOCKET_DISCONNECTED' });
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[WatchInk BG] WebSocket error:', err);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    } catch (e) {
      console.error('[WatchInk BG] Failed to parse message:', e);
    }
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[WatchInk BG] Attempting reconnect...');
    connectWebSocket(serverUrl);
  }, 3000);
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.warn('[WatchInk BG] Cannot send — socket not open');
  }
}

// ─── Handle messages from the server ─────────────────────────────────────────
function handleServerMessage(data) {
  // Validate: every server message must have an 'event' field
  if (!data || typeof data.event !== 'string') return;

  console.log('[WatchInk BG] Server event received:', data.event);

  switch (data.event) {
    case 'room_created':
      console.log('[WatchInk BG] Relaying room_created to content');
      sendToContent({ type: 'ROOM_CREATED', roomId: data.roomId, users: data.users });
      break;

    case 'room_joined':
      sendToContent({ type: 'ROOM_JOINED', roomId: data.roomId, users: data.users });
      break;

    case 'room_error':
      sendToContent({ type: 'ROOM_ERROR', message: data.message });
      break;

    case 'users_updated':
      sendToContent({ type: 'USERS_UPDATED', users: data.users });
      break;

    case 'host_transferred':
      sendToContent({ type: 'HOST_TRANSFERRED', newHostUsername: data.newHostUsername, users: data.users });
      break;

    case 'sync_play':
      sendToContent({ type: 'SYNC_PLAY', currentTime: data.currentTime, currentUrl: data.currentUrl });
      break;

    case 'sync_pause':
      sendToContent({ type: 'SYNC_PAUSE', currentTime: data.currentTime, currentUrl: data.currentUrl });
      break;

    case 'sync_seek':
      sendToContent({ type: 'SYNC_SEEK', currentTime: data.currentTime, currentUrl: data.currentUrl });
      break;

    case 'sync_time':
      sendToContent({ type: 'SYNC_TIME', currentTime: data.currentTime, currentUrl: data.currentUrl });
      break;

    case 'sync_next_episode':
      sendToContent({ type: 'SYNC_NEXT_EPISODE', targetUrl: data.targetUrl, currentTime: data.currentTime });
      break;

    case 'resync_response':
      sendToContent({ type: 'SYNC_SEEK', currentTime: data.currentTime });
      break;

    case 'pong':
      sendToContent({ type: 'PONG' });
      break;

    case 'guests_ready_status':
      sendToContent({ type: 'GUESTS_READY_STATUS', allReady: data.allReady, users: data.users });
      break;

    case 'room_expired':
      sendToContent({ type: 'ROOM_EXPIRED' });
      break;

    default:
      console.log('[WatchInk BG] Unknown server event:', data.event);
  }
}

// ─── Handle messages from content scripts ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleContentMessage(msg, sender);
  // Return true if we need async response (not needed here)
  return false;
});

function handleContentMessage(msg, sender) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'INIT_SOCKET':
      serverUrl = msg.serverUrl || serverUrl;
      connectWebSocket(serverUrl);
      // If there's a room to re-join on startup
      if (msg.roomId) {
        pendingRoom = {
          roomId: msg.roomId,
          username: msg.username,
          isHost: msg.isHost,
        };
      }
      break;

    case 'CREATE_ROOM':
      send({
        event: 'create_room',
        roomId: msg.roomId,
        username: msg.username,
      });
      break;

    case 'JOIN_ROOM':
      send({
        event: 'join_room',
        roomId: msg.roomId,
        username: msg.username,
      });
      break;

    case 'LEAVE_ROOM':
      send({
        event: 'leave_room',
        roomId: msg.roomId,
        username: msg.username,
      });
      break;

    case 'RECONNECT':
      pendingRoom = {
        roomId: msg.roomId,
        username: msg.username,
        isHost: msg.isHost,
      };
      connectWebSocket(serverUrl);
      break;

    case 'EMIT_PLAY':
      send({ event: 'play', roomId: msg.roomId, currentTime: msg.currentTime, currentUrl: msg.currentUrl });
      break;

    case 'EMIT_PAUSE':
      send({ event: 'pause', roomId: msg.roomId, currentTime: msg.currentTime, currentUrl: msg.currentUrl });
      break;

    case 'EMIT_SEEK':
      send({ event: 'seek', roomId: msg.roomId, currentTime: msg.currentTime, currentUrl: msg.currentUrl });
      break;

    case 'EMIT_TIME':
      send({ event: 'time_sync', roomId: msg.roomId, currentTime: msg.currentTime, currentUrl: msg.currentUrl });
      break;

    case 'EMIT_NEXT_EPISODE':
      send({ event: 'next_episode', roomId: msg.roomId, targetUrl: msg.targetUrl, currentTime: msg.currentTime });
      break;

    case 'REQUEST_RESYNC':
      send({ event: 'request_resync', roomId: msg.roomId });
      break;

    case 'GUEST_READY':
      send({ event: 'guest_ready', roomId: msg.roomId });
      break;

    case 'PING':
      send({ event: 'ping', roomId: msg.roomId });
      break;
  }
}

// ─── Keep service worker alive (MV3 workaround) ───────────────────────────────
// MV3 service workers can be terminated. We use a periodic alarm to keep it alive.
chrome.alarms.create('watchink-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'watchink-keepalive') {
    // Ping the socket to keep connection alive
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ event: 'keepalive' });
    } else if (!isConnected) {
      connectWebSocket(serverUrl);
    }
  }
});

console.log('[WatchInk BG] Background service worker started');
