/**
 * WatchInk Beta — Popup Script
 * Shows extension status and quick actions.
 */

'use strict';

function isSupportedUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase();
    return [
      'disneyplus.com',
      'netflix.com',
      'primevideo.com',
      'youtube.com',
      'youtu.be',
      'amazon.com'
    ].some(s => host === s || host.endsWith('.' + s));
  } catch (e) {
    return false;
  }
}

async function init() {
  const openSiteBtn = document.getElementById('open-disney-btn');
  const openWatchinkBtn = document.getElementById('open-watchink-btn');
  const statusTitle = document.getElementById('status-title');
  const statusSub = document.getElementById('status-sub');
  const statusDot = document.getElementById('status-dot');
  const statusIcon = document.getElementById('status-icon');
  const roomInfoText = document.getElementById('room-info-text');

  // Search for supported sites with multiple strategies
  const supportedHosts = ['disneyplus.com', 'netflix.com', 'primevideo.com', 'youtube.com', 'youtu.be', 'amazon.com'];

  const queryPatterns = [
    'https://*.disneyplus.com/*',
    'https://*.apps.disneyplus.com/*',
    'https://*.netflix.com/*',
    'https://*.primevideo.com/*',
    'https://primevideo.com/*',
    'https://*.youtube.com/*',
    'https://*.youtu.be/*'
  ];

  let activeTab = null;

  // First check the current active tab in the focused window
  const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (currentTabs.length > 0 && currentTabs[0].url && isSupportedUrl(currentTabs[0].url)) {
    activeTab = currentTabs[0];
  }

  // Next look through explicit query list (supports non-focused windows)
  if (!activeTab) {
    const tabs = await chrome.tabs.query({ url: queryPatterns });
    for (const tab of tabs) {
      if (tab.url && isSupportedUrl(tab.url)) {
        activeTab = tab;
        break;
      }
    }
  }

  // Finally fallback to scanning all tabs with strict host matching
  if (!activeTab) {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (tab.url && isSupportedUrl(tab.url)) {
        activeTab = tab;
        break;
      }
    }
  }

  if (activeTab) {
    openSiteBtn.style.display = 'none';
    openWatchinkBtn.style.display = 'flex';

    const matchedHost = supportedHosts.find(host => activeTab.url.includes(host));
    const siteName = matchedHost ? matchedHost.replace('www.', '') : 'Supported site';

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
      statusTitle.textContent = `${siteName} is open`;
      statusSub.textContent = 'Click below to open WatchInk';
      statusDot.className = 'dot connected';
      statusIcon.textContent = '✦';
    }

    // Bring the active supported content tab to focus and open panel
    openWatchinkBtn.addEventListener('click', async () => {
      try {
        console.log('[WatchInk Popup] Clicking WatchInk button');

        if (activeTab?.id) {
          await chrome.tabs.update(activeTab.id, { active: true });
          if (activeTab.windowId) {
            try {
              await chrome.windows.update(activeTab.windowId, { focused: true });
            } catch (e) {
              console.warn('[WatchInk Popup] Could not focus window:', e);
            }
          }
        }

        // Route through background to make message delivery robust.
        chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[WatchInk Popup] OPEN_PANEL runtime message failed:', chrome.runtime.lastError.message);
          } else {
            console.log('[WatchInk Popup] OPEN_PANEL sent to background', response);
          }
        });

      } catch (e) {
        console.error('[WatchInk Popup] Failed to activate tab:', e);
      }

      setTimeout(() => window.close(), 500);
    });

      } catch (e) {
        console.error('[WatchInk Popup] Failed to activate tab:', e);
      }

      setTimeout(() => window.close(), 500);
    });

  } else {
    statusTitle.textContent = 'No supported video site open';
    statusSub.textContent = 'Open Netflix, Prime Video, YouTube or Disney+ to start';
    statusDot.className = 'dot disconnected';
    statusIcon.textContent = '🎬';

    openSiteBtn.textContent = 'Open Disney+ to start';
    openSiteBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://www.disneyplus.com' });
      window.close();
    });
  }
}

init().catch(console.error);
