// Vimeo Video Downloader - Background Service Worker
importScripts('storage.js');

const signedConfigUrls = new Map();

// Intercept signed config URLs from Vimeo player
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    if (url.includes('/video/') && url.includes('/config')) {
      const m = url.match(/\/video\/(\d+)\/config/);
      if (m) {
        const hasSignature = url.includes('?');
        const existing = signedConfigUrls.get(m[1]);
        if (!existing || hasSignature) {
          signedConfigUrls.set(m[1], url);
          console.log(`[VimeoDL] Intercepted config for ${m[1]} (signed: ${hasSignature})`);
        }
      }
    }
  },
  { urls: ['*://*.vimeo.com/*', '*://player.vimeo.com/*'] }
);

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'download') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename || 'vimeo-video.mp4',
      saveAs: true,
    });
    return false;
  }

  if (message.action === 'fetchConfig') {
    handleFetchConfig(message).then(config => sendResponse({ config }));
    return true;
  }

  if (message.action === 'downloadDash') {
    const tabId = sender.tab?.id;
    handleDashDownload(message, tabId)
      .then(() => sendResponse({ success: true }))
      .catch(e => {
        console.error('[VimeoDL] DASH download error:', e);
        sendResponse({ error: e.message });
      });
    return true;
  }
});

// ===== Config fetching =====
async function handleFetchConfig(message) {
  const { videoId, pageUrl } = message;
  console.log(`[VimeoDL] Fetching config for video ${videoId}`);

  // Method 1: Intercepted signed URL
  const signedUrl = signedConfigUrls.get(videoId);
  if (signedUrl && signedUrl.includes('?')) {
    try {
      const resp = await fetch(signedUrl);
      if (resp.ok) {
        const text = await resp.text();
        if (text.startsWith('{')) {
          const config = JSON.parse(text);
          if (config.request?.files) {
            console.log('[VimeoDL] Config obtained via signed URL');
            return config;
          }
        }
      }
    } catch (e) { console.log('[VimeoDL] Signed URL failed:', e.message); }
  }

  // Method 2: Wait and retry signed URL
  if (!signedUrl || !signedUrl.includes('?')) {
    await new Promise(r => setTimeout(r, 2000));
    const signedUrl2 = signedConfigUrls.get(videoId);
    if (signedUrl2 && signedUrl2.includes('?')) {
      try {
        const resp = await fetch(signedUrl2);
        if (resp.ok) {
          const text = await resp.text();
          if (text.startsWith('{')) {
            const config = JSON.parse(text);
            if (config.request?.files) return config;
          }
        }
      } catch (e) { /* */ }
    }
  }

  // Method 3: Direct with Referer
  try {
    const resp = await fetch(`https://player.vimeo.com/video/${videoId}/config`, {
      headers: { 'Referer': pageUrl || `https://vimeo.com/${videoId}` },
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text.startsWith('{')) {
        const config = JSON.parse(text);
        if (config.request?.files) return config;
      }
    }
  } catch (e) { /* */ }

  console.log('[VimeoDL] All config methods failed');
  return null;
}

// ===== DASH Download =====
// Send progress to content script
function sendProgress(tabId, text) {
  if (tabId) {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'progress', text });
    } catch (e) { /* ignore */ }
  }
}

async function handleDashDownload({ cdnUrl, filename }, tabId) {
  console.log('[VimeoDL] Starting DASH download, CDN URL:', cdnUrl);
  sendProgress(tabId, 'Loading video info...');

  // 1. Fetch master.json
  const masterUrl = cdnUrl.replace(/\/[^/]*$/, '/master.json') +
    (cdnUrl.includes('?') ? '' : '?base64_init=1');

  let masterData;
  const urlsToTry = [cdnUrl, masterUrl];

  for (const url of urlsToTry) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const text = await resp.text();
        if (text.startsWith('{')) {
          masterData = JSON.parse(text);
          if (masterData.video && masterData.audio) break;
        }
      }
    } catch (e) { /* try next */ }
  }

  if (!masterData || !masterData.video || !masterData.audio) {
    throw new Error('Could not fetch master.json');
  }

  // 2. Find best video and audio tracks
  const bestVideo = masterData.video.reduce((best, v) =>
    (v.height || 0) > (best.height || 0) ? v : best, masterData.video[0]);
  const bestAudio = masterData.audio.reduce((best, a) =>
    (a.bitrate || 0) > (best.bitrate || 0) ? a : best, masterData.audio[0]);

  const quality = `${bestVideo.width}x${bestVideo.height}`;
  console.log(`[VimeoDL] Best video: ${quality}`);
  sendProgress(tabId, `${quality} - Downloading video...`);

  // 3. Base URL
  const masterBaseUrl = cdnUrl.substring(0, cdnUrl.lastIndexOf('/') + 1);

  // 4. Download video segments
  const totalVideoSegs = bestVideo.segments?.length || 0;
  const totalAudioSegs = bestAudio.segments?.length || 0;
  const totalSegs = totalVideoSegs + totalAudioSegs;

  const videoData = await downloadSegments(masterBaseUrl, bestVideo, masterData.base_url, (done) => {
    const pct = Math.round((done / totalSegs) * 100);
    sendProgress(tabId, `Downloading... ${pct}%`);
  });

  sendProgress(tabId, `Downloading audio...`);

  // 5. Download audio segments
  const audioData = await downloadSegments(masterBaseUrl, bestAudio, masterData.base_url, (done) => {
    const pct = Math.round(((totalVideoSegs + done) / totalSegs) * 100);
    sendProgress(tabId, `Downloading... ${pct}%`);
  });

  // 6. Mux video + audio
  sendProgress(tabId, 'Muxing video + audio...');
  console.log('[VimeoDL] Muxing video + audio...');
  await muxWithOffscreen(videoData, audioData, filename);

  sendProgress(tabId, 'Done!');
  console.log('[VimeoDL] Download complete!');
}

async function downloadSegments(masterBaseUrl, track, globalBaseUrl, onProgress) {
  const parts = [];

  // Build the base URL for this track's segments
  let trackBaseUrl = masterBaseUrl;
  if (globalBaseUrl) {
    trackBaseUrl += globalBaseUrl;
  }
  if (track.base_url) {
    trackBaseUrl += track.base_url;
  }

  // Init segment (base64 encoded)
  if (track.init_segment) {
    const initData = base64ToArrayBuffer(track.init_segment);
    parts.push(initData);
    console.log(`[VimeoDL] Init segment: ${initData.byteLength} bytes`);
  }

  // Download each segment
  const segments = track.segments || [];
  console.log(`[VimeoDL] Downloading ${segments.length} segments...`);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segUrl = trackBaseUrl + seg.url;

    let retries = 3;
    while (retries > 0) {
      try {
        const resp = await fetch(segUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.arrayBuffer();
        parts.push(data);
        break;
      } catch (e) {
        retries--;
        if (retries === 0) throw new Error(`Failed to download segment ${i}: ${e.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if ((i + 1) % 5 === 0 || i === segments.length - 1) {
      console.log(`[VimeoDL] Progress: ${i + 1}/${segments.length}`);
      if (onProgress) onProgress(i + 1);
    }
  }

  // Concatenate all parts
  const totalSize = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const part of parts) {
    result.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }

  console.log(`[VimeoDL] Track complete: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  return result.buffer;
}

function base64ToArrayBuffer(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}

// Mux using offscreen document + IndexedDB for large data transfer
async function muxWithOffscreen(videoData, audioData, filename) {
  // Store data in IndexedDB (shared between service worker and offscreen doc)
  console.log('[VimeoDL] Storing data in IndexedDB...');
  await storeBlob('video', videoData);
  await storeBlob('audio', audioData);
  console.log('[VimeoDL] Data stored in IndexedDB');

  // Create offscreen document if needed
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Mux video and audio streams',
    });
  }

  // Tell offscreen doc to mux AND trigger download (it has URL.createObjectURL)
  return new Promise((resolve, reject) => {
    const messageHandler = async (message) => {
      if (message.action === 'downloadReady') {
        chrome.runtime.onMessage.removeListener(messageHandler);
        // Offscreen doc created a blob URL, use it to download
        chrome.downloads.download({
          url: message.blobUrl,
          filename: filename,
          saveAs: true,
        }, () => {
          // Tell offscreen to revoke the blob URL after download starts
          chrome.runtime.sendMessage({ action: 'cleanup' });
        });
        await clearBlobs();
        resolve();
      }

      if (message.action === 'muxError') {
        chrome.runtime.onMessage.removeListener(messageHandler);
        await clearBlobs();
        reject(new Error(message.error));
      }
    };

    chrome.runtime.onMessage.addListener(messageHandler);
    chrome.runtime.sendMessage({ action: 'mux' });
  });
}
