/**
 * WatchInk Beta — Popup Script
 * Shows extension status and quick actions.
 */

'use strict';

async function init() {
  const openDisneyBtn = document.getElementById('open-disney-btn');
  const openWatchinkBtn = document.getElementById('open-watchink-btn');
  const statusTitle = document.getElementById('status-title');
  const statusSub = document.getElementById('status-sub');
  const statusDot = document.getElementById('status-dot');
  const statusIcon = document.getElementById('status-icon');
  const roomInfoText = document.getElementById('room-info-text');

  // Find the current active tab
  let activeTab = null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && (tab.url.startsWith('https://') || tab.url.startsWith('http://'))) {
    activeTab = tab;
  }

  if (activeTab) {
    openDisneyBtn.style.display = 'none';
    openWatchinkBtn.style.display = 'flex';

    // Check stored room state
    const stored = await chrome.storage.local.get(['wi_room', 'wi_username', 'wi_host']);
    const roomId = stored.wi_room;
    const username = stored.wi_username;

    if (roomId) {
      statusTitle.textContent = `Room: ${roomId}`;
      statusSub.textContent = `As ${username || 'unknown'} · ${stored.wi_host ? 'Host' : 'Guest'}`;
      statusDot.className = 'dot in-room';
      statusIcon.textContent = '🟢';
      roomInfoText.textContent = `Active: ${roomId}`;
      roomInfoText.style.color = '#E5173F';
      roomInfoText.style.fontWeight = '600';
    } else {
      const hostname = new URL(activeTab.url).hostname;
      statusTitle.textContent = `Ready on ${hostname}`;
      statusSub.textContent = 'Click below to open WatchInk';
      statusDot.className = 'dot connected';
      statusIcon.textContent = '✦';
    }

    openWatchinkBtn.addEventListener('click', async () => {
      try {
        console.log('[WatchInk Popup] Clicking WatchInk button, tab ID:', activeTab.id);

        await chrome.tabs.update(activeTab.id, { active: true });

        if (activeTab.windowId) {
          try {
            await chrome.windows.update(activeTab.windowId, { focused: true });
          } catch (e) {
            console.warn('[WatchInk Popup] Could not focus window:', e);
          }
        }

        let messageAttempts = 0;
        const sendPanelMessage = () => {
          messageAttempts++;
          console.log('[WatchInk Popup] Sending OPEN_PANEL message (attempt ' + messageAttempts + ')');
          chrome.tabs.sendMessage(activeTab.id, { type: 'OPEN_PANEL' }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn('[WatchInk Popup] Message failed:', chrome.runtime.lastError.message);
              if (messageAttempts < 2) {
                console.log('[WatchInk Popup] Retrying message in 300ms...');
                setTimeout(sendPanelMessage, 300);
              }
            } else {
              console.log('[WatchInk Popup] Message sent successfully, response:', response);
            }
          });
        };

        setTimeout(sendPanelMessage, 200);

      } catch (e) {
        console.error('[WatchInk Popup] Failed to activate tab:', e);
      }

      setTimeout(() => window.close(), 500);
    });

  } else {
    statusTitle.textContent = 'No supported page open';
    statusSub.textContent = 'Navigate to a streaming site to start';
    statusDot.className = 'dot disconnected';
    statusIcon.textContent = '🎬';

    openDisneyBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://www.netflix.com' });
      window.close();
    });
  }
}

init().catch(console.error);