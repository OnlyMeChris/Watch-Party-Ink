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

  // Search for Disney+ tab with multiple strategies
  let disneyTab = null;

  // Strategy 1: Exact URL match with pattern
  let tabs = await chrome.tabs.query({
    url: ['https://www.disneyplus.com/*', 'https://disneyplus.com/*']
  });

  if (tabs.length > 0) {
    disneyTab = tabs[0];
  } else {
    // Strategy 2: Check all tabs for Disney+ in URL
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (tab.url && tab.url.includes('disneyplus.com')) {
        disneyTab = tab;
        break;
      }
    }
  }

  if (disneyTab) {
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
      statusTitle.textContent = 'Disney+ is open';
      statusSub.textContent = 'Click below to open WatchInk';
      statusDot.className = 'dot connected';
      statusIcon.textContent = '✦';
    }

    // Bring Disney+ tab to focus and trigger panel open
    openWatchinkBtn.addEventListener('click', async () => {
      try {
        console.log('[WatchInk Popup] Clicking WatchInk button, tab ID:', disneyTab.id);
        
        // Activate the tab
        await chrome.tabs.update(disneyTab.id, { active: true });
        
        // Try to focus the window (with error handling)
        if (disneyTab.windowId) {
          try {
            await chrome.windows.update(disneyTab.windowId, { focused: true });
          } catch (e) {
            console.warn('[WatchInk Popup] Could not focus window:', e);
          }
        }
        
        // Try to send message with retry logic
        let messageAttempts = 0;
        const sendPanelMessage = () => {
          messageAttempts++;
          console.log('[WatchInk Popup] Sending OPEN_PANEL message (attempt ' + messageAttempts + ')');
          chrome.tabs.sendMessage(disneyTab.id, { type: 'OPEN_PANEL' }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn('[WatchInk Popup] Message failed:', chrome.runtime.lastError.message);
              // Retry once if it failed due to timing
              if (messageAttempts < 2) {
                console.log('[WatchInk Popup] Retrying message in 300ms...');
                setTimeout(sendPanelMessage, 300);
              }
            } else {
              console.log('[WatchInk Popup] Message sent successfully, response:', response);
            }
          });
        };
        
        // First attempt after small delay
        setTimeout(sendPanelMessage, 200);
        
      } catch (e) {
        console.error('[WatchInk Popup] Failed to activate Disney+ tab:', e);
      }
      
      setTimeout(() => window.close(), 500);
    });

  } else {
    statusTitle.textContent = 'Disney+ not open';
    statusSub.textContent = 'Open Disney+ to start';
    statusDot.className = 'dot disconnected';
    statusIcon.textContent = '🎬';

    openDisneyBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://www.disneyplus.com' });
      window.close();
    });
  }
}

init().catch(console.error);
