/**
 * WatchInk Beta — Content Script
 * Injected into Disney+ pages.
 * Handles: UI rendering, video player hooks, sync engine, socket comms.
 */

'use strict';

// TEST: Ultra simple logging
try {
  console.log('WatchInk script file loaded - before any functions');
} catch (e) {}


// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  SERVER_URL: 'ws://localhost:3001',           // WebSocket endpoint
  DRIFT_THRESHOLD_MS: 500,                      // Seek if drift > 500ms
  DRIFT_CHECK_INTERVAL: 3000,                   // Check drift every 3s
  SYNC_DEBOUNCE_MS: 300,                        // Debounce event sends
  RECONNECT_DELAY_MS: 3000,                     // Reconnect after 3s
  MAX_RECONNECT_ATTEMPTS: 10,
  ADJUSTER_RATE: 0.05,                          // playbackRate micro-adjust
};

// ─── State ────────────────────────────────────────────────────────────────────
const STATE = {
  socket: null,
  roomId: null,
  username: null,
  isHost: false,
  isMuted: false,                               // Mute sync toggle
  isSyncing: false,                             // Prevent feedback loops
  isConnected: false,
  users: [],
  allGuestsReady: true,                         // Track if all guests are ready
  hostTime: null,
  hostTimestamp: null,                          // When hostTime was recorded
  latency: 0,
  driftMs: 0,
  pingStart: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
  driftInterval: null,
  lastUrl: location.href,
  videoObserver: null,
  isNavigatingAway: false,                      // Flag to prevent messages during navigation
};

// ─── Utility ──────────────────────────────────────────────────────────────────

function generateUsername() {
  const adj = ['Red','Blue','Swift','Dark','Bright','Wild','Bold','Calm','Keen','Cool'];
  const noun = ['Falcon','Hawk','Wolf','Fox','Bear','Lynx','Eagle','Viper','Raven','Tiger'];
  return adj[Math.floor(Math.random()*adj.length)] + noun[Math.floor(Math.random()*noun.length)] + Math.floor(Math.random()*90+10);
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length: 6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function getVideo() {
  return document.querySelector('video');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg, type = 'default', duration = 2500) {
  let container = document.getElementById('watchink-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'watchink-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `wi-toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── Reconnect Banner ─────────────────────────────────────────────────────────

function showReconnectBanner(show) {
  let banner = document.getElementById('watchink-reconnect-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'watchink-reconnect-banner';
    banner.innerHTML = `<div class="reconnect-spinner"></div><span>Reconnecting to WatchInk...</span>`;
    document.body.appendChild(banner);
  }
  banner.classList.toggle('visible', show);
}

// ─── HUD (floating in-session widget) ────────────────────────────────────────

function renderHUD() {
  let hud = document.getElementById('watchink-hud');
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'watchink-hud';
    document.body.appendChild(hud);
  }
  const statusText = STATE.isMuted ? 'Sync paused' :
    STATE.isHost && !STATE.allGuestsReady ? 'Waiting for guests...' :
    STATE.driftMs > CONFIG.DRIFT_THRESHOLD_MS ? `Drift: ${STATE.driftMs}ms` : 'In sync';
  const dotClass = STATE.isMuted ? 'drifting' :
    !STATE.isConnected ? 'connecting' :
    STATE.isHost && !STATE.allGuestsReady ? 'connecting' :
    STATE.driftMs > CONFIG.DRIFT_THRESHOLD_MS ? 'drifting' : 'synced';

  hud.innerHTML = `
    <div class="hud-icon">🎬</div>
    <div class="hud-info">
      <div class="hud-room">${STATE.roomId || '---'}</div>
      <div class="hud-status">${STATE.users.length} watching · ${statusText}</div>
    </div>
    <div class="wi-sync-dot ${dotClass}" style="width:7px;height:7px;border-radius:50%;flex-shrink:0;"></div>
    <button class="hud-expand-btn" id="wi-hud-expand" title="Open WatchInk">⬆</button>
  `;

  document.getElementById('wi-hud-expand')?.addEventListener('click', () => {
    showMainPanel();
  });
}

// ─── Main Panel UI ────────────────────────────────────────────────────────────

function removeModal() {
  document.getElementById('watchink-modal-backdrop')?.remove();
}

function showWelcomeModal() {
  removeModal();
  const backdrop = document.createElement('div');
  backdrop.id = 'watchink-modal-backdrop';
  backdrop.className = 'wi-modal-backdrop';
  const initial = STATE.username?.[0]?.toUpperCase() || 'W';

  backdrop.innerHTML = `
    <div class="wi-modal" role="dialog" aria-label="WatchInk Beta">
      ${modalHeader()}
      <div class="wi-modal-body">
        <div class="wi-welcome-title">Watch together, perfectly.</div>
        <div class="wi-welcome-sub">Create a room to host a watch party, or join a friend's room with a code.</div>
        
        <div class="wi-username-display">
          <div class="wi-username-avatar">${initial}</div>
          <div class="wi-username-info">
            <div class="wi-username-label">Your name</div>
            <div class="wi-username-value">${STATE.username}</div>
          </div>
        </div>

        <div class="wi-btn-row">
          <button class="wi-btn wi-btn-primary" id="wi-create-room-btn">
            <span>✦</span> Create Room
          </button>
          <button class="wi-btn wi-btn-secondary" id="wi-show-join-btn">
            <span>→</span> Join Room
          </button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('watchink-root').appendChild(backdrop);

  document.getElementById('wi-create-room-btn').addEventListener('click', () => {
    const roomId = generateRoomId();
    joinOrCreateRoom(roomId, true);
  });

  document.getElementById('wi-show-join-btn').addEventListener('click', showJoinModal);
  document.getElementById('wi-modal-close').addEventListener('click', () => {
    removeModal();
    renderHUD();
  });

  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) { removeModal(); renderHUD(); }
  });
}

function showJoinModal() {
  removeModal();
  const backdrop = document.createElement('div');
  backdrop.id = 'watchink-modal-backdrop';
  backdrop.className = 'wi-modal-backdrop';

  backdrop.innerHTML = `
    <div class="wi-modal" role="dialog">
      ${modalHeader('Join a Room')}
      <div class="wi-modal-body">
        <div class="wi-input-group">
          <label class="wi-input-label" for="wi-room-code-input">Room Code</label>
          <input class="wi-input" id="wi-room-code-input" type="text" placeholder="e.g. XK7M2P" maxlength="6" autocomplete="off" spellcheck="false" />
        </div>
        <button class="wi-btn wi-btn-primary wi-btn-full" id="wi-join-confirm-btn">Join Room →</button>
        <button class="wi-btn wi-btn-ghost wi-btn-full" id="wi-back-btn" style="margin-top:4px;">← Back</button>
      </div>
    </div>
  `;

  document.getElementById('watchink-root').appendChild(backdrop);

  const input = document.getElementById('wi-room-code-input');
  input.focus();
  input.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('wi-join-confirm-btn').click();
  });

  document.getElementById('wi-join-confirm-btn').addEventListener('click', () => {
    const code = input.value.trim().toUpperCase();
    if (code.length < 4) { showToast('Enter a valid room code', 'error'); return; }
    joinOrCreateRoom(code, false);
  });

  document.getElementById('wi-back-btn').addEventListener('click', showWelcomeModal);
  document.getElementById('wi-modal-close').addEventListener('click', removeModal);

  backdrop.addEventListener('click', e => { if (e.target === backdrop) removeModal(); });
}

function showMainPanel() {
  removeModal();
  const backdrop = document.createElement('div');
  backdrop.id = 'watchink-modal-backdrop';
  backdrop.className = 'wi-modal-backdrop';

  const dotClass = STATE.isMuted ? 'drifting' :
    !STATE.isConnected ? 'connecting' :
    STATE.driftMs > CONFIG.DRIFT_THRESHOLD_MS ? 'drifting' : 'synced';
  const statusLabel = !STATE.isConnected ? 'Connecting...' :
    STATE.isMuted ? 'Sync paused' :
    STATE.isHost && !STATE.allGuestsReady ? 'Waiting for guests to load...' :
    STATE.driftMs > CONFIG.DRIFT_THRESHOLD_MS ? `Drift: ${STATE.driftMs}ms` : 'Synced';
  const latencyText = STATE.latency ? `${STATE.latency}ms` : '---';

  const usersHtml = STATE.users.map(u => {
    const isYou = u.username === STATE.username;
    const isHost = u.isHost;
    const isReady = u.isReady !== false;
    const initial = u.username?.[0]?.toUpperCase() || '?';
    return `
      <div class="wi-user-item">
        <div class="wi-user-avatar ${isHost ? 'host' : ''}">${initial}</div>
        <div class="wi-user-name">${u.username}${isYou ? ' (you)' : ''}</div>
        ${isHost ? '<span class="wi-user-badge host">Host</span>' : ''}
        ${isYou && !isHost ? '<span class="wi-user-badge you">You</span>' : ''}
        ${!isHost && !isReady ? '<span class="wi-user-badge loading">Loading...</span>' : ''}
        ${!isHost && isReady ? '<span class="wi-user-badge ready">✓</span>' : ''}
      </div>
    `;
  }).join('');

  backdrop.innerHTML = `
    <div class="wi-modal" role="dialog">
      ${modalHeader('Room · ' + STATE.roomId)}
      <div class="wi-modal-body">

        <div class="wi-room-id-block">
          <div class="wi-room-id-info">
            <div class="wi-room-id-label">Room Code</div>
            <div class="wi-room-id-value">${STATE.roomId}</div>
          </div>
          <button class="wi-copy-btn" id="wi-copy-room-id" title="Copy room code">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>

        <div class="wi-sync-bar">
          <div class="wi-sync-dot ${dotClass}"></div>
          <div class="wi-sync-text">${statusLabel}</div>
          <div class="wi-sync-latency">${latencyText}</div>
        </div>

        <div class="wi-section-label">${STATE.users.length} in room</div>
        <div class="wi-users-list">${usersHtml || '<div style="color:var(--wi-gray-400);font-size:13px;padding:8px 0;">Waiting for others...</div>'}</div>

        <div class="wi-divider"></div>

        <div class="wi-toggle-row">
          <span class="wi-toggle-label">🔇 Mute sync (watch freely)</span>
          <label class="wi-toggle">
            <input type="checkbox" id="wi-mute-toggle" ${STATE.isMuted ? 'checked' : ''}>
            <span class="wi-toggle-slider"></span>
          </label>
        </div>

        <div class="wi-action-row" style="margin-top:14px;">
          <button class="wi-btn wi-btn-primary" id="wi-resync-btn" style="flex:1;">⟳ Resync Now</button>
          <button class="wi-btn wi-btn-secondary" id="wi-leave-btn" style="flex:1;">Leave Room</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('watchink-root').appendChild(backdrop);

  document.getElementById('wi-copy-room-id').addEventListener('click', () => {
    navigator.clipboard.writeText(STATE.roomId).then(() => {
      const btn = document.getElementById('wi-copy-room-id');
      btn?.classList.add('copied');
      showToast('Room code copied!', 'success');
      setTimeout(() => btn?.classList.remove('copied'), 2000);
    });
  });

  document.getElementById('wi-resync-btn').addEventListener('click', () => {
    forceResync();
    showToast('Resyncing...', 'default');
  });

  document.getElementById('wi-leave-btn').addEventListener('click', () => {
    leaveRoom();
  });

  document.getElementById('wi-mute-toggle').addEventListener('change', e => {
    STATE.isMuted = e.target.checked;
    chrome.storage.local.set({ wi_muted: STATE.isMuted });
    showToast(STATE.isMuted ? 'Sync paused — watching freely' : 'Sync resumed', 'default');
    updateHUD();
  });

  document.getElementById('wi-modal-close').addEventListener('click', () => {
    removeModal();
    renderHUD();
  });

  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) { removeModal(); renderHUD(); }
  });
}

function modalHeader(subtitle = '') {
  return `
    <div class="wi-modal-header">
      <button class="wi-close-btn" id="wi-modal-close" aria-label="Close">✕</button>
      <div class="wi-logo">
        <div class="wi-logo-mark">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </div>
        <span class="wi-logo-text">WatchInk</span>
        <span class="wi-logo-beta">Beta</span>
      </div>
      ${subtitle ? `<div class="wi-modal-tagline">${subtitle}</div>` : '<div class="wi-modal-tagline">Sync. Watch. Together.</div>'}
    </div>
  `;
}

function updateHUD() {
  if (STATE.roomId) renderHUD();
}

// ─── Socket Connection ────────────────────────────────────────────────────────

function connectSocket() {
  // Load socket.io client from CDN via background script messaging
  // We inject a script tag to load socket.io since content scripts can't easily import ESM
  chrome.runtime.sendMessage({ type: 'NEED_SOCKET_IO' });
}

// The background worker coordinates socket communication via message passing
// Content script <-> background script via chrome.runtime.sendMessage/onMessage

function sendToBackground(type, data = {}) {
  // Don't try to send if we're navigating away
  if (STATE.isNavigatingAway) {
    console.warn('[WatchInk] Blocked message send during navigation:', type);
    return;
  }
  
  try {
    // Verify chrome.runtime is still available (context not invalidated)
    if (!chrome?.runtime?.sendMessage) {
      console.warn('[WatchInk] Chrome runtime not available');
      return;
    }
    
    const response = chrome.runtime.sendMessage({ type, ...data });
    if (response && typeof response.then === 'function') {
      response.catch(err => {
        if (!err?.message?.includes('Receiving end does not exist')) {
          console.error('[WatchInk] Message send error:', err?.message || err);
        }
        if (err?.message?.includes('Extension context invalidated') || err?.message?.includes('Receiving end does not exist')) {
          stopDriftChecker();
        }
      });
    }
  } catch (err) {
    if (!err?.message?.includes('Receiving end does not exist')) {
      console.warn('[WatchInk] sendToBackground error:', err?.message || err);
    }
    if (err?.message?.includes('Extension context invalidated') || err?.message?.includes('Receiving end does not exist')) {
      stopDriftChecker();
    }
  }
}

// Listen for messages from background (socket events relayed back)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[WatchInk] Message received from background:', msg.type);
  handleBackgroundMessage(msg);
  // Always send a response to confirm receipt
  sendResponse({ received: true });
  return true;
});

function handleBackgroundMessage(msg) {
  if (!msg || !msg.type) return;
  
  console.log('[WatchInk] Handling background message:', msg.type);
  
  switch (msg.type) {
    case 'OPEN_PANEL':
      console.log('[WatchInk] Opening panel. Room ID:', STATE.roomId);
      if (STATE.roomId) showMainPanel();
      else showWelcomeModal();
      return;
    case 'SOCKET_CONNECTED':
      STATE.isConnected = true;
      STATE.reconnectAttempts = 0;
      showReconnectBanner(false);
      updateHUD();
      if (STATE.roomId) showToast('Connected!', 'success');
      break;

    case 'SOCKET_DISCONNECTED':
      STATE.isConnected = false;
      updateHUD();
      scheduleReconnect();
      break;

    case 'ROOM_CREATED':
      console.log('[WatchInk] ROOM_CREATED received with roomId:', msg.roomId);
      STATE.roomId = msg.roomId;
      STATE.isHost = true;
      STATE.users = msg.users || [];
      console.log('[WatchInk] Saving room to storage:', msg.roomId);
      chrome.storage.local.set({ wi_room: msg.roomId, wi_host: true });
      showToast(`Room ${msg.roomId} created!`, 'success');
      console.log('[WatchInk] Showing main panel for room:', msg.roomId);
      showMainPanel();
      startDriftChecker();
      break;

    case 'ROOM_JOINED':
      STATE.roomId = msg.roomId;
      STATE.isHost = false;
      STATE.users = msg.users || [];
      chrome.storage.local.set({ wi_room: msg.roomId, wi_host: false });
      showToast(`Joined room ${msg.roomId}!`, 'success');
      
      // If room has a current URL, navigate to it
      if (msg.currentUrl && msg.currentUrl !== location.href) {
        console.log('[WatchInk] Current room URL:', msg.currentUrl);
        STATE.isNavigatingAway = true;
        stopDriftChecker();  // Stop before navigation
        window.location.href = msg.currentUrl;
        return;
      }
      
      showMainPanel();
      startDriftChecker();
      break;

    case 'ROOM_ERROR':
      showToast(msg.message || 'Room error', 'error');
      showWelcomeModal();
      break;

    case 'USERS_UPDATED':
      STATE.users = msg.users || [];
      updateHUD();
      if (document.getElementById('watchink-modal-backdrop')) showMainPanel();
      break;

    case 'HOST_TRANSFERRED':
      STATE.isHost = (msg.newHostUsername === STATE.username);
      STATE.users = msg.users || [];
      if (STATE.isHost) showToast('You are now the host', 'success');
      updateHUD();
      break;

    case 'SYNC_PLAY':
      // Handle URL change if provided
      if (msg.currentUrl && msg.currentUrl !== location.href) {
        console.log('[WatchInk] Syncing to new URL:', msg.currentUrl);
        STATE.isNavigatingAway = true;
        stopDriftChecker();  // Stop before navigation
        window.location.href = msg.currentUrl;
        return;
      }
      if (!STATE.isMuted) handleRemotePlay(msg.currentTime);
      break;

    case 'SYNC_PAUSE':
      // Handle URL change if provided
      if (msg.currentUrl && msg.currentUrl !== location.href) {
        console.log('[WatchInk] Syncing to new URL:', msg.currentUrl);
        STATE.isNavigatingAway = true;
        stopDriftChecker();  // Stop before navigation
        window.location.href = msg.currentUrl;
        return;
      }
      if (!STATE.isMuted) handleRemotePause(msg.currentTime);
      break;

    case 'SYNC_SEEK':
      // Handle URL change if provided
      if (msg.currentUrl && msg.currentUrl !== location.href) {
        console.log('[WatchInk] Syncing to new URL:', msg.currentUrl);
        STATE.isNavigatingAway = true;
        stopDriftChecker();  // Stop before navigation
        window.location.href = msg.currentUrl;
        return;
      }
      if (!STATE.isMuted) handleRemoteSeek(msg.currentTime);
      break;

    case 'SYNC_TIME':
      // Drift correction data from host
      STATE.hostTime = msg.currentTime;
      STATE.hostTimestamp = performance.now();
      
      // Handle URL change (e.g., host switched episodes)
      if (msg.currentUrl && msg.currentUrl !== location.href) {
        console.log('[WatchInk] Syncing to new URL:', msg.currentUrl);
        STATE.isNavigatingAway = true;
        stopDriftChecker();  // Stop before navigation
        window.location.href = msg.currentUrl;
        return;
      }
      
      if (!STATE.isMuted && !STATE.isHost) applyDriftCorrection();
      break;

    case 'SYNC_NEXT_EPISODE':
      if (!STATE.isMuted && !STATE.isHost) handleNextEpisode(msg.targetUrl, msg.currentTime);
      break;

    case 'GUESTS_READY_STATUS':
      STATE.allGuestsReady = msg.allReady;
      STATE.users = msg.users || [];
      if (STATE.isHost) {
        // Host: pause if guests aren't ready, show "Waiting for..."
        const vid = getVideo();
        if (vid && !STATE.allGuestsReady && !vid.paused) {
          console.log('[WatchInk] Host pausing - waiting for guests to load');
          withSyncLock(() => { vid.pause(); });
          showToast('Waiting for guests to load...', 'default', 3000);
        }
      }
      updateHUD();
      break;

    case 'PONG':
      if (STATE.pingStart) {
        STATE.latency = Math.round((performance.now() - STATE.pingStart) / 2);
        STATE.pingStart = null;
        updateHUD();
      }
      break;

    case 'ROOM_EXPIRED':
      leaveRoom();
      showToast('Room has expired', 'error');
      break;
  }
}

function scheduleReconnect() {
  if (STATE.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
    showToast('Could not reconnect. Please refresh.', 'error');
    return;
  }
  STATE.reconnectAttempts++;
  showReconnectBanner(true);
  clearTimeout(STATE.reconnectTimer);
  STATE.reconnectTimer = setTimeout(() => {
    sendToBackground('RECONNECT', {
      roomId: STATE.roomId,
      username: STATE.username,
      isHost: STATE.isHost,
    });
  }, CONFIG.RECONNECT_DELAY_MS * Math.min(STATE.reconnectAttempts, 3));
}

// ─── Room Actions ─────────────────────────────────────────────────────────────

function joinOrCreateRoom(roomId, asHost) {
  const action = asHost ? 'CREATE_ROOM' : 'JOIN_ROOM';
  sendToBackground(action, {
    roomId: roomId.toUpperCase(),
    username: STATE.username,
  });
  showToast(asHost ? 'Creating room...' : 'Joining room...', 'default');
}

function leaveRoom() {
  sendToBackground('LEAVE_ROOM', { roomId: STATE.roomId, username: STATE.username });
  STATE.roomId = null;
  STATE.isHost = false;
  STATE.users = [];
  stopDriftChecker();
  removeModal();
  document.getElementById('watchink-hud')?.remove();
  showWelcomeModal();
  chrome.storage.local.remove(['wi_room', 'wi_host']);
  showToast('Left the room', 'default');
}

// ─── Video Player Hooks ───────────────────────────────────────────────────────

let videoEl = null;
let videoListenersAttached = false;

function findAndAttachVideo() {
  const vid = getVideo();
  if (vid && vid !== videoEl) {
    videoEl = vid;
    attachVideoListeners(vid);
    // Guest sends ready signal when video is loaded (but not during navigation)
    if (!STATE.isHost && STATE.roomId && !STATE.isNavigatingAway) {
      setTimeout(() => {
        // Double-check we're not navigating before sending
        if (!STATE.isNavigatingAway && STATE.roomId) {
          try {
            sendToBackground('GUEST_READY', { roomId: STATE.roomId });
            console.log('[WatchInk] Guest signaled ready');
          } catch (e) {
            console.warn('[WatchInk] Failed to send ready signal:', e.message);
          }
        }
      }, 500);  // Give video a moment to settle
    }
  }
}

const debouncedSendSeek = debounce((time) => {
  if (!STATE.isSyncing && STATE.isHost && STATE.roomId) {
    sendToBackground('EMIT_SEEK', { roomId: STATE.roomId, currentTime: time, currentUrl: location.href });
  }
}, CONFIG.SYNC_DEBOUNCE_MS);

// Debounce guest seek warning toast (don't spam)
const debouncedGuestSeekWarning = debounce(() => {
  try {
    showToast('Only host can seek', 'default', 1500);
  } catch (e) {
    console.warn('[WatchInk] Toast error:', e.message);
  }
}, 2000);

function attachVideoListeners(vid) {
  if (videoListenersAttached) return;
  videoListenersAttached = true;

  vid.addEventListener('play', () => {
    if (STATE.isSyncing || !STATE.isHost || !STATE.roomId) return;
    sendToBackground('EMIT_PLAY', { roomId: STATE.roomId, currentTime: vid.currentTime, currentUrl: location.href });
  });

  vid.addEventListener('pause', () => {
    // If guest tries to pause, just ignore it (don't send pause events)
    if (!STATE.isHost && !STATE.isMuted && STATE.roomId) {
      return;
    }
    // Only host can send pause events
    if (STATE.isSyncing || !STATE.isHost || !STATE.roomId) return;
    sendToBackground('EMIT_PAUSE', { roomId: STATE.roomId, currentTime: vid.currentTime, currentUrl: location.href });
  });

  // Seek detection: compare before/after currentTime
  let lastTime = vid.currentTime;
  vid.addEventListener('timeupdate', () => {
    try {
      const delta = Math.abs(vid.currentTime - lastTime);
      
      // If guest tries to seek/move forward, snap back to host time
      if (!STATE.isHost && !STATE.isMuted && STATE.roomId && delta > 1.5 && STATE.hostTime !== null) {
        STATE.isSyncing = true;
        vid.currentTime = STATE.hostTime;
        setTimeout(() => { STATE.isSyncing = false; }, 600);
        debouncedGuestSeekWarning();
      }
      
      // A delta > 1s that wasn't from normal play = a seek (host only)
      if (delta > 1.5 && STATE.isHost && STATE.roomId) {
        debouncedSendSeek(vid.currentTime);
      }
      lastTime = vid.currentTime;
    } catch (e) {
      console.error('[WatchInk] timeupdate error:', e.message);
    }
  });

  console.log('[WatchInk] Video player hooked successfully');
}

// ─── Remote Playback Control ──────────────────────────────────────────────────

function withSyncLock(fn) {
  STATE.isSyncing = true;
  fn();
  setTimeout(() => { STATE.isSyncing = false; }, 600);
}

function handleRemotePlay(time) {
  const vid = getVideo();
  if (!vid) return;
  withSyncLock(() => {
    if (Math.abs(vid.currentTime - time) > 0.5) vid.currentTime = time;
    vid.play().catch(() => {});
  });
}

function handleRemotePause(time) {
  const vid = getVideo();
  if (!vid) return;
  withSyncLock(() => {
    vid.pause();
    if (Math.abs(vid.currentTime - time) > 0.5) vid.currentTime = time;
  });
}

function handleRemoteSeek(time) {
  const vid = getVideo();
  if (!vid) return;
  withSyncLock(() => {
    vid.currentTime = time;
  });
}

// ─── Drift Correction ─────────────────────────────────────────────────────────

function startDriftChecker() {
  stopDriftChecker();
  STATE.driftInterval = setInterval(() => {
    if (!STATE.roomId || !STATE.isConnected) return;

    // Measure latency via ping
    STATE.pingStart = performance.now();
    sendToBackground('PING', { roomId: STATE.roomId });

    // Host: broadcast current time for drift correction
    if (STATE.isHost) {
      const vid = getVideo();
      if (vid && !vid.paused) {
        sendToBackground('EMIT_TIME', {
          roomId: STATE.roomId,
          currentTime: vid.currentTime,
          currentUrl: location.href,        // Send current URL
        });
      }
    }
  }, CONFIG.DRIFT_CHECK_INTERVAL);
}

function stopDriftChecker() {
  if (STATE.driftInterval) {
    clearInterval(STATE.driftInterval);
    STATE.driftInterval = null;
  }
}

function applyDriftCorrection() {
  if (!STATE.hostTime || !STATE.hostTimestamp) return;
  const vid = getVideo();
  if (!vid || vid.paused) return;

  // Account for latency: estimate current host time
  const elapsed = (performance.now() - STATE.hostTimestamp) / 1000;
  const estimatedHostTime = STATE.hostTime + elapsed + (STATE.latency / 1000);
  const drift = Math.abs(vid.currentTime - estimatedHostTime);
  STATE.driftMs = Math.round(drift * 1000);

  if (drift > CONFIG.DRIFT_THRESHOLD_MS / 1000) {
    if (drift > 3) {
      // Hard seek for large drift
      withSyncLock(() => { vid.currentTime = estimatedHostTime; });
      showToast(`Resynced (${STATE.driftMs}ms drift)`, 'default', 1500);
    } else {
      // Soft adjust playbackRate for small drift
      const adjusting = vid.currentTime < estimatedHostTime ? 1 + CONFIG.ADJUSTER_RATE : 1 - CONFIG.ADJUSTER_RATE;
      vid.playbackRate = adjusting;
      setTimeout(() => { vid.playbackRate = 1.0; }, 2000);
    }
  } else {
    STATE.driftMs = 0;
    if (vid.playbackRate !== 1.0) vid.playbackRate = 1.0;
  }

  updateHUD();
}

// ─── Guest Override (snap back to host) ──────────────────────────────────────
// Guests are gently snapped back if they try to take control

function setupGuestOverrides() {
  // We watch for guest-initiated changes, but we override via drift correction.
  // This is handled naturally: if a guest seeks, drift correction will snap back
  // within DRIFT_CHECK_INTERVAL ms. No need to completely disable player controls
  // (which would break DRM / Disney+), so we let the drift engine handle it.
  if (!STATE.isHost && !STATE.isMuted) {
    console.log('[WatchInk] Guest mode — drift correction will maintain sync');
  }
}

// ─── Force Resync ─────────────────────────────────────────────────────────────

function forceResync() {
  sendToBackground('REQUEST_RESYNC', { roomId: STATE.roomId });
}

// ─── Next Episode Detection ───────────────────────────────────────────────────

let lastPageUrl = location.href;

function checkForEpisodeChange() {
  // Only trigger episode change if we're in a room AND the URL actually changed
  if (STATE.roomId && location.href !== lastPageUrl) {
    lastPageUrl = location.href;
    videoListenersAttached = false;
    videoEl = null;
    // Give the player time to load
    setTimeout(() => {
      findAndAttachVideo();
      if (STATE.isHost && STATE.roomId) {
        sendToBackground('EMIT_NEXT_EPISODE', {
          roomId: STATE.roomId,
          targetUrl: location.href,
          currentTime: 0,
        });
      }
    }, 3000);
  }
}

function handleNextEpisode(targetUrl, time) {
  if (!targetUrl) return;
  // Only navigate if on a different episode
  if (location.href !== targetUrl) {
    showToast('Loading next episode...', 'default', 3000);
    setTimeout(() => {
      STATE.isNavigatingAway = true;
      stopDriftChecker();
      history.pushState(null, '', targetUrl);
      location.href = targetUrl;
    }, 500);
  }
}

// ─── URL/Route Change Watcher ─────────────────────────────────────────────────

const origPushState = history.pushState.bind(history);
history.pushState = function(...args) {
  origPushState(...args);
  setTimeout(checkForEpisodeChange, 100);
};
window.addEventListener('popstate', () => setTimeout(checkForEpisodeChange, 100));

// ─── DOM Observer (find video element dynamically) ────────────────────────────

function observeForVideo() {
  STATE.videoObserver = new MutationObserver(() => {
    if (!videoEl || !document.contains(videoEl)) {
      videoListenersAttached = false;
      videoEl = null;
      findAndAttachVideo();
    }
  });
  STATE.videoObserver.observe(document.body, { childList: true, subtree: true });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

let hasInited = false;

async function init() {
  if (hasInited) return;
  hasInited = true;
  console.log('[WatchInk] Init starting...');
  
  if (!document.body) { 
    console.log('[WatchInk] No document.body yet, waiting for DOMContentLoaded');
    document.addEventListener('DOMContentLoaded', () => { hasInited = false; init(); }); 
    return; 
  }
  
  // Inject CSS
  try {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('styles.css');
    document.head.appendChild(link);
    console.log('[WatchInk] CSS injected');
  } catch (e) {
    console.error('[WatchInk] CSS injection failed:', e);
  }
  
  console.log('[WatchInk] Document body found, proceeding with init');
  
  // Ensure root exists + guard against Disney+ SPA wiping it
  if (!document.getElementById('watchink-root')) {
    const root = document.createElement('div');
    root.id = 'watchink-root';
    document.body.appendChild(root);
    console.log('[WatchInk] Created watchink-root element');
  }

  const stored = await chrome.storage.local.get(['wi_username', 'wi_room', 'wi_host', 'wi_muted']).catch(() => ({}));
  STATE.username = stored.wi_username || generateUsername();
  STATE.isMuted = stored.wi_muted || false;
  chrome.storage.local.set({ wi_username: STATE.username });
  if (stored.wi_room) { STATE.roomId = stored.wi_room; STATE.isHost = stored.wi_host || false; }

  console.log('[WatchInk] Loaded state. Username:', STATE.username, 'RoomId:', STATE.roomId);

  sendToBackground('INIT_SOCKET', { serverUrl: CONFIG.SERVER_URL, username: STATE.username, roomId: STATE.roomId, isHost: STATE.isHost });

  // Delay 1.5s so Disney+ finishes its own render before we inject the modal
  setTimeout(() => {
    console.log('[WatchInk] Showing UI. Has room:', !!STATE.roomId);
    if (!STATE.roomId) showWelcomeModal();
    else { renderHUD(); startDriftChecker(); }
  }, 1500);

  findAndAttachVideo();
  setInterval(() => {
    if (!videoEl || !document.contains(videoEl)) { videoListenersAttached = false; videoEl = null; findAndAttachVideo(); }
  }, 2000);
  
  // Set up SPA guard after init
  try {
    new MutationObserver(() => {
      if (!document.getElementById('watchink-root') && STATE.username) {
        const root = document.createElement('div'); 
        root.id = 'watchink-root'; 
        document.body.appendChild(root);
        if (STATE.roomId) renderHUD();
      }
    }).observe(document.body, { childList: true });
  } catch (e) {
    console.warn('[WatchInk] Failed to set up SPA guard:', e.message);
  }
  
  console.log('[WatchInk] Init complete');
}

// ─── Startup ─────────────────────────────────────────────────────────────────

try {
  console.log('WatchInk startup: document.readyState =', document.readyState);
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }
} catch (err) {
  console.error('WatchInk startup error:', err);
}
