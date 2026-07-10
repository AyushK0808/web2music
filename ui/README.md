# Web2Music — Feature C: Extension Shell & Playback Engine

The Chrome extension (Manifest V3) that ties the Web2Music pipeline together: it watches the active tab, extracts lightweight page signals, drives ambient audio playback, and exposes the popup UI. Internally this is "Adaptive Audio" (see `manifest.json`).

## Position in the pipeline

```
Feature A/B (page signals → music profile)
    │
    ▼
Feature C ◄── YOU ARE HERE
    │  content.js   – extracts page signals from the active tab
    │  background.js – service worker: tab/media monitoring, state, backend calls
    │  offscreen.js  – Tone.js audio graph (the only context allowed to play audio in MV3)
    │  popup.js      – popup UI: enable/disable, play/pause, volume, current-page card
    ▼
Playback (ducked around YouTube/Spotify/Netflix/Twitch/SoundCloud)
```

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: permissions (`storage`, `tabs`, `alarms`, `offscreen`, `idle`, `scripting`), service worker, content script, popup. |
| `content.js` | Runs on every page (`document_idle`). Extracts title, meta description, first ~2000 chars of body text, paragraph/image/video counts, and body background colour, then messages it to the background worker. Debounced via a timestamp cooldown to survive re-injection. |
| `background.js` | Service worker. Manages `audioState` (status, current tab/URL/profile, ducking, enabled/paused flags), monitors tabs for media-heavy domains (`MEDIA_DOMAINS`) to duck audio, and owns the offscreen document lifecycle. Holds `fetchMusicProfile()` / `fetchAudioUrl()` against `BACKEND_URL = http://localhost:8000` (`/profile`, `/generate`) — currently commented out pending integration with Feature B/D. |
| `offscreen.js` | The offscreen document (MV3 requires audio playback to happen outside the service worker). Builds the Tone.js audio graph: `Tone.Player` → `Tone.EQ3` → `Tone.Reverb` → `Tone.Volume` (master gain, default -6dB) → output, plus an FFT `Tone.Analyser` for visualisation. Handles fade in/out via `gainNode.volume.rampTo()`. |
| `offscreen.html` | Minimal host page for `offscreen.js`. |
| `popup.html` / `popup.js` | Popup UI: master enable toggle, play/pause, volume slider, and a "current page" card (favicon, title, URL, status tag). Samples the page favicon's dominant colour via an offscreen canvas to tint the card. |
| `assets/Tone.js` | Vendored [Tone.js](https://tonejs.github.io/) build used by `offscreen.js`. |

## Status

The extraction and playback shell is functional and loadable as-is. The backend integration (fetching a music profile and generated audio URL from a Feature D-style server) is stubbed out in `background.js` — swapping the inline `extractPageData()` in `content.js` for Feature A's richer extractors, and wiring the commented-out `fetchMusicProfile()`/`fetchAudioUrl()` calls to Feature B and Feature D, is the main remaining integration work.

## Running it

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select the `feature-c-extension/` directory.
4. Browse normally; open the extension popup to toggle playback and volume.

No build step — the extension runs directly from source.
