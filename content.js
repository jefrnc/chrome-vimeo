// Vimeo Video Downloader - Content Script

(function () {
  'use strict';

  const PROCESSED = new WeakSet();

  function extractVideoId(src) {
    if (!src) return null;
    const m = src.match(/(?:vimeo\.com\/|\/video\/)(\d+)/);
    return m ? m[1] : null;
  }

  function getVideoIdFromPage() {
    const m = window.location.href.match(/vimeo\.com\/(\d+)/);
    return m ? m[1] : null;
  }

  // Send message to background with error handling
  function sendMsg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            console.log('[VimeoDL] sendMessage error:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch (e) {
        console.log('[VimeoDL] sendMessage exception:', e.message);
        resolve(null);
      }
    });
  }

  function fetchVideoConfigViaBackground(videoId) {
    return sendMsg({ action: 'fetchConfig', videoId, pageUrl: window.location.href })
      .then(r => r && r.config ? r.config : null);
  }

  // Extract download options from config (progressive + DASH)
  function getDownloadOptions(config) {
    const options = [];

    // Progressive MP4 (direct download, easiest)
    try {
      const progressive = config.request.files.progressive;
      if (Array.isArray(progressive)) {
        for (const f of progressive) {
          options.push({
            type: 'progressive',
            quality: f.quality || `${f.height}p`,
            width: f.width,
            height: f.height,
            url: f.url,
            label: `${f.quality || f.height + 'p'} MP4`,
          });
        }
      }
    } catch (e) { /* */ }

    // DASH (separate video+audio, needs muxing)
    try {
      const dash = config.request.files.dash;
      if (dash && dash.cdns) {
        // Get the first CDN URL
        const cdnKeys = Object.keys(dash.cdns);
        if (cdnKeys.length > 0) {
          const cdnUrl = dash.cdns[cdnKeys[0]].url || dash.cdns[cdnKeys[0]].avc_url;
          if (cdnUrl) {
            options.push({
              type: 'dash',
              quality: 'Best',
              label: 'Best Quality (DASH)',
              cdnUrl: cdnUrl,
              dashConfig: dash,
            });
          }
        }
      }
    } catch (e) { /* */ }

    // Sort: progressive first (easiest), then DASH
    options.sort((a, b) => {
      if (a.type === 'progressive' && b.type !== 'progressive') return -1;
      if (a.type !== 'progressive' && b.type === 'progressive') return 1;
      return (b.height || 0) - (a.height || 0);
    });

    return options;
  }

  function getVideoTitle(config) {
    try { return config.video.title || 'vimeo-video'; }
    catch (e) { return 'vimeo-video'; }
  }

  function sanitizeFilename(name) {
    return name.replace(/[^\w\s\-().]/g, '').replace(/\s+/g, '_').substring(0, 100);
  }

  function createDownloadIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>';
    return svg;
  }

  function injectOverlay(playerEl, videoId) {
    if (PROCESSED.has(playerEl)) return;
    PROCESSED.add(playerEl);

    const style = window.getComputedStyle(playerEl);
    if (style.position === 'static') {
      playerEl.style.position = 'relative';
    }
    playerEl.classList.add('vimeo-dl-wrapper');

    const btn = document.createElement('button');
    btn.className = 'vimeo-dl-btn';
    btn.appendChild(createDownloadIcon());
    btn.appendChild(document.createTextNode('Download'));

    const menu = document.createElement('div');
    menu.className = 'vimeo-dl-menu';

    let menuLoaded = false;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (menu.classList.contains('vimeo-dl-open')) {
        menu.classList.remove('vimeo-dl-open');
        return;
      }

      menu.classList.add('vimeo-dl-open');
      if (menuLoaded) return;

      menu.innerHTML = '<div class="vimeo-dl-menu-loading">Loading qualities...</div>';

      try {
        let config = await fetchVideoConfigViaBackground(videoId);

        if (!config) {
          menu.innerHTML = '<div class="vimeo-dl-menu-error">Could not load video info</div>';
          return;
        }

        const options = getDownloadOptions(config);
        const title = sanitizeFilename(getVideoTitle(config));

        if (options.length === 0) {
          menu.innerHTML = '<div class="vimeo-dl-menu-error">No downloadable files found</div>';
          return;
        }

        menu.innerHTML = '';

        for (const opt of options) {
          const item = document.createElement('button');
          item.className = 'vimeo-dl-menu-item';

          const qualitySpan = document.createElement('span');
          qualitySpan.className = 'vimeo-dl-quality';
          qualitySpan.textContent = opt.label;

          const sizeSpan = document.createElement('span');
          sizeSpan.className = 'vimeo-dl-size';

          if (opt.type === 'progressive') {
            sizeSpan.textContent = opt.width && opt.height ? `${opt.width}x${opt.height}` : '';
          } else if (opt.type === 'dash') {
            sizeSpan.textContent = 'HD';
          }

          item.appendChild(qualitySpan);
          item.appendChild(sizeSpan);

          // Use mousedown + capture to guarantee we get the event
          // before Vimeo's player can intercept it
          item.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            console.log('[VimeoDL Content] Menu item CLICKED:', opt.type, opt.label);
            menu.classList.remove('vimeo-dl-open');
            handleDownload(opt, title, btn);
          }, true);

          // Also block click from bubbling to player
          item.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ev.stopImmediatePropagation();
          }, true);

          menu.appendChild(item);
        }

        menuLoaded = true;
      } catch (err) {
        menu.innerHTML = `<div class="vimeo-dl-menu-error">Error: ${err.message}</div>`;
      }
    });

    document.addEventListener('click', (e) => {
      if (!btn.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.remove('vimeo-dl-open');
      }
    });

    playerEl.appendChild(btn);
    playerEl.appendChild(menu);
  }

  // Listen for progress updates from background
  let activeBtn = null;
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'progress' && activeBtn) {
      activeBtn.textContent = message.text;
      if (message.text === 'Done!') {
        setTimeout(() => resetButton(activeBtn), 2500);
        activeBtn = null;
      }
    }
  });

  function resetButton(btn) {
    btn.innerHTML = '';
    btn.appendChild(createDownloadIcon());
    btn.appendChild(document.createTextNode('Download'));
    btn.disabled = false;
    btn.style.opacity = '';
  }

  async function handleDownload(opt, title, btn) {
    console.log('[VimeoDL Content] handleDownload:', opt.type);
    if (opt.type === 'progressive') {
      sendMsg({
        action: 'download',
        url: opt.url,
        filename: `${title}_${opt.quality}.mp4`,
      });
    } else if (opt.type === 'dash') {
      activeBtn = btn;
      btn.textContent = 'Starting...';
      btn.disabled = true;
      btn.style.opacity = '0.8';

      const response = await sendMsg({
        action: 'downloadDash',
        cdnUrl: opt.cdnUrl,
        filename: `${title}_best.mp4`,
      });

      if (response && response.error) {
        console.error('[VimeoDL Content] DASH error:', response.error);
        btn.textContent = 'Error: ' + response.error;
        setTimeout(() => resetButton(btn), 4000);
        activeBtn = null;
      }
    }
  }

  function scanForPlayers() {
    if (window.location.hostname.includes('vimeo.com')) {
      const videoId = getVideoIdFromPage();
      if (videoId) {
        const player =
          document.querySelector('.player_area') ||
          document.querySelector('[data-player]') ||
          document.querySelector('.vp-video-wrapper') ||
          document.querySelector('.player') ||
          document.querySelector('video')?.closest('div');
        if (player) injectOverlay(player, videoId);
      }
    }

    if (window.location.hostname === 'player.vimeo.com') {
      const videoId = extractVideoId(window.location.href);
      if (videoId) {
        const player =
          document.querySelector('.vp-video-wrapper') ||
          document.querySelector('.player') ||
          document.querySelector('video')?.parentElement;
        if (player) injectOverlay(player, videoId);
      }
    }

    const iframes = document.querySelectorAll('iframe[src*="player.vimeo.com"]');
    for (const iframe of iframes) {
      const videoId = extractVideoId(iframe.src);
      if (videoId && iframe.parentElement && !PROCESSED.has(iframe.parentElement)) {
        const wrapper = iframe.parentElement;
        const s = window.getComputedStyle(wrapper);
        if (s.position === 'static') wrapper.style.position = 'relative';
        injectOverlay(wrapper, videoId);
      }
    }
  }

  function init() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }
    scanForPlayers();
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'IFRAME' || node.querySelector?.('iframe[src*="vimeo"]') ||
                node.querySelector?.('video') || node.classList?.contains('player')) {
              shouldScan = true; break;
            }
          }
        }
        if (shouldScan) break;
      }
      if (shouldScan) setTimeout(scanForPlayers, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
