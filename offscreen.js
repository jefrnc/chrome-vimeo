// Offscreen document for muxing video + audio
// Uses native JS MP4 muxer (no external dependencies)

let activeBlobUrl = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'mux') {
    handleMux();
  }
  if (message.action === 'cleanup') {
    if (activeBlobUrl) {
      URL.revokeObjectURL(activeBlobUrl);
      activeBlobUrl = null;
    }
  }
});

async function handleMux() {
  try {
    console.log('[VimeoDL Offscreen] Starting mux...');

    const videoData = await getBlob('video');
    const audioData = await getBlob('audio');

    if (!videoData || !audioData) {
      throw new Error('Video or audio data not found in IndexedDB');
    }

    console.log(`[VimeoDL Offscreen] Video: ${(videoData.byteLength / 1024 / 1024).toFixed(1)} MB`);
    console.log(`[VimeoDL Offscreen] Audio: ${(audioData.byteLength / 1024 / 1024).toFixed(1)} MB`);

    // Use native JS muxer
    const muxedData = muxFmp4(videoData, audioData);

    // Create blob URL
    const blob = new Blob([muxedData], { type: 'video/mp4' });
    activeBlobUrl = URL.createObjectURL(blob);

    console.log(`[VimeoDL Offscreen] Blob URL created, size: ${(blob.size / 1024 / 1024).toFixed(1)} MB`);

    chrome.runtime.sendMessage({
      action: 'downloadReady',
      blobUrl: activeBlobUrl,
    });
  } catch (e) {
    console.error('[VimeoDL Offscreen] Mux error:', e);
    chrome.runtime.sendMessage({ action: 'muxError', error: e.message });
  }
}
