# Vimeo Video Downloader - Chrome Extension

Chrome extension that adds a download overlay button on Vimeo videos, allowing you to download them in the best available quality with audio.

## Features

- **Overlay download button** on any Vimeo video page
- **DASH stream support** — downloads the highest quality video + audio and muxes them together
- **Progressive MP4 support** — direct download when available
- **Native JS MP4 muxer** — no external dependencies (ffmpeg, WASM, CDN)
- **Real-time progress** shown on the download button
- **Works on vimeo.com** and embedded Vimeo players on third-party sites
- **Manifest V3** compliant

## How It Works

1. A content script detects Vimeo players and injects a download button overlay
2. When clicked, the extension intercepts the signed config URL that the Vimeo player uses
3. It fetches the video config to find available streams
4. For DASH streams (most common): downloads video and audio segments separately, then muxes them into a single MP4 using a lightweight native JS muxer
5. For progressive MP4 (when available): downloads the file directly

### Architecture

| File | Role |
|---|---|
| `manifest.json` | Extension config (MV3) |
| `content.js` | Detects Vimeo player, injects overlay button, shows quality menu |
| `background.js` | Service worker — intercepts signed config URLs, downloads DASH segments |
| `muxer.js` | Native JS fMP4 muxer — combines separate video + audio tracks |
| `storage.js` | IndexedDB wrapper for passing large data between service worker and offscreen doc |
| `offscreen.html/js` | Offscreen document for running the muxer (has DOM APIs unavailable in service workers) |
| `overlay.css` | Styles for the download button and quality dropdown |

### Download Flow (DASH)

```
Page loads → content.js injects button
         → background.js intercepts signed config URL from player

User clicks Download → content.js requests config via background
                    → background fetches master.json (DASH manifest)
                    → downloads all video segments (init + data)
                    → downloads all audio segments (init + data)
                    → stores in IndexedDB
                    → offscreen.js reads from IndexedDB
                    → muxer.js combines video + audio into single MP4
                    → creates blob URL → triggers chrome.downloads
```

## Installation

1. Clone this repo:
   ```bash
   git clone https://github.com/jefrnc/chrome-vimeo.git
   ```
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `chrome-vimeo` folder

## Usage

1. Navigate to any Vimeo video page
2. A blue **Download** button appears in the top-left corner of the player
3. Click it to see available qualities
4. Select **Best Quality (DASH)** to download in the highest quality with audio
5. The button shows real-time progress: `Downloading... 45%` → `Muxing video + audio...` → `Done!`

## Limitations

- **DRM-protected videos** (Vimeo Enterprise) cannot be downloaded — hardware encryption
- **Signed URLs expire** — download starts immediately after clicking, but if you wait too long the URLs may expire
- **Large videos** require enough RAM for the muxing process (video + audio buffers in memory)
- **First click after page load** — the extension needs the player to load first so it can intercept the signed config URL. If the button doesn't work, refresh the page and try again.

## Technical Notes

- Uses `chrome.webRequest` to intercept the Vimeo player's authenticated config requests (signed with HMAC)
- The native JS muxer handles fragmented MP4 (CMAF) format specifically — it parses MP4 box structures, renumbers track IDs, and concatenates fragments
- Large data (video/audio buffers) is passed between service worker and offscreen document via IndexedDB to avoid Chrome's 64 MiB message size limit
- Blob URLs for download are created in the offscreen document since `URL.createObjectURL` is not available in service workers

## License

MIT
