# Web2Music — Feature C: Extension Shell & Playback Engine

The Chrome extension (Manifest V3) that ties the Web2Music pipeline together: it watches the active tab, runs Feature A's extraction and Feature B's classification in-browser, calls Feature D for audio, and drives playback and the popup UI. Internally this is "Adaptive Audio" (see `manifest.json`).

## Position in the pipeline

Features A and B do not run as separate services — they are bundled into the extension. `build.mjs` pulls Feature A's extractors out of `data-extraction/` and Feature B's classifier out of `mood-classification/`, so the only network hop is Feature D (and, optionally, the classify proxy that B's LLM tier calls).

```
Content script (page origin)      Service worker (background.js)     Offscreen document
──────────────────────────────    ──────────────────────────────     ──────────────────────
Feature A extraction              Feature B: B1 → B2 → B3 → B4       Audio playback engine
text · colour · behaviour         Feature D client (HTTP :8000)      MiniLM embed worker
                                  ducking · idle · telemetry         IndexedDB vector store
        │                                    │                                  ▲
        │  A_PAGE_DATA                       │  LOAD_TRACK / DUCK / FADE_* …    │
        └───────────────────────────────────►└─────────────────────────────────►│
        │                                                                       │
        │  A_EMBED / A_VS_* — ONNX inference and IndexedDB can't run under a     │
        └──page's CSP and origin, so they are relayed through the worker ───────►┘
```

Playback is ducked around media-heavy domains (YouTube/Spotify/Netflix/Twitch/SoundCloud) and faded out on idle.

## Files

Source lives in `src/` and is bundled into `dist/` by `build.mjs`. **Load `dist/`, never `ui/` itself.**

| Source (`src/`) | Role |
|---|---|
| `content.entry.js` | Feature A's extraction driver, injected on every page. Delegates to `buildPageData` (loaded as classic `vendor/*.js` scripts — see the note below) and re-runs on SPA navigation and throttled DOM churn, then sends `A_PAGE_DATA` to the worker. |
| `background.entry.js` | MV3 service worker. Wires Feature B in-process via `onHandoff2` (a `runtime.sendMessage` broadcast never reaches its own sender), owns the offscreen document's lifecycle, monitors tabs for ducking, handles idle fade-out, and serves the popup's message surface. |
| `featureDClient.js` | Feature D HTTP client. One `AbortController` per request so a new mood cancels a stale generation, and instant-fallback-then-swap: `GET /fallback/{mood}` starts playing immediately while `POST /generate` runs in parallel. Reads `backendUrl` from `chrome.storage.local` on every call. |
| `offscreen.entry.js` | The offscreen document (MV3 forbids audio in a service worker). Two alternating decks over raw `AudioBufferSourceNode`s — not `Tone.Player`, so `loopStart`/`loopEnd` can honour D4's `loop_point_ms` — into four independent gain stages (`crossfade → user → duck → moodFade`) so unducking can't erase Feature B's fade, then Tone's `EQ3` → `Reverb` → `Analyser`. |
| `offscreenExtract.js` | The offscreen half of Feature A's embedding and vector store: owns the embed worker and `window.Web2MusicVectorStore`. |
| `offscreenTypes.js` | The single source of truth for which message types are Feature A extract RPCs. Routing keys on message *type*, not on `target` — `offscreen_routing_test.js` is the regression cover for the bug where that distinction was missing and every audio command was swallowed. |
| `remoteDeps.js` | Content-script-side proxies for the two RPCs above, round-tripped through the worker. |
| `embed.worker.js` | Web Worker hosting transformers.js + MiniLM ONNX, spawned from the offscreen document so inference can't stall the audio thread. Fully offline (`allowRemoteModels = false`). |
| `telemetry.js` | Local-only ring buffer in `chrome.storage.local`. URLs are SHA-256 hashed before storage, and nothing leaves the machine until the popup's Export button is pressed. |

| Static (copied verbatim into `dist/`) | Role |
|---|---|
| `manifest.json` | MV3 manifest: `storage`, `tabs`, `alarms`, `offscreen`, `idle`, `scripting`, `downloads`, plus `<all_urls>` host permissions and a `wasm-unsafe-eval` CSP for ONNX. |
| `popup.html` / `popup.js` | Enable toggle, play/pause, mute, volume, skip/regenerate, an FFT visualiser, a "current page" card, a mood-correction dropdown, and telemetry export. |
| `offscreen.html` | Host page for the offscreen bundle; loads Tone.js and `vendor/VectorStore.js` as classic scripts first. |
| `assets/Tone.js` | Vendored [Tone.js](https://tonejs.github.io/) — the gain, EQ, reverb and analyser nodes. |
| `models/`, `onnx/` | Vendored MiniLM weights and ONNX runtime. Absent on a fresh checkout — see `models/README.md`. |

`build.mjs` also copies Feature A's DOM extractors from `data-extraction/` into `dist/vendor/` **verbatim rather than bundling them**: they use a `typeof module !== 'undefined'` UMD check, and esbuild's CJS interop would take the wrong branch and silently never attach `window.Web2Music*`.

## Running it

From the repo root:

```
npm run build         # bundles A + B + the shell into ui/dist/
npm run build:watch   # same, rebuilding on change
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select **`ui/dist/`**.
4. Browse normally; open the popup to toggle playback and volume.

Two backends sit behind this, and they fail very differently:

- **Feature D on `:8000`** is what actually produces audio — without it there is nothing to play. It sits behind a compose profile, so `npm run up` alone does *not* start it: use `docker compose -f docker/docker-compose.yml --profile cpu up feature-d` (or `--profile gpu`), set `COMPOSE_PROFILES=cpu` in `.env`, or run `audio-generation/` directly.
- **The classify proxy on `:8078`** backs Feature B's LLM tier, and `npm run up` does start it. Without it — or without a Groq key — B1/B2 log `Failed to fetch` and fall back to tier-1 keyword heuristics. That is a working degraded path, not a failure: the extension keeps classifying and playing.

## Tests

`node ui/offscreen_routing_test.js` covers the message routing described above and runs as part of the root `npm test`.

## End-to-end tests

`npm run test:e2e` builds the extension and browses a corpus of mood-varied pages in a real Chromium with it loaded, asserting what Feature B classified each page as and handed to Feature D.

```
npm run test:e2e                                  # all 12 pages, headless
npm run test:e2e -- --headed                      # watch it run
npm run test:e2e -- --only=tense_border_standoff  # one page
```

| File | Role |
|---|---|
| `e2e/moodSites.js` | The corpus: one page per mood in B2's `MOODS` enum, plus a sensitive page that must produce silence. Read its header before editing the prose — the copy is written against `MOOD_RULES`' exact keyword forms so each page resolves on tier-1 alone. |
| `e2e/harnessServer.mjs` | Serves the corpus, stands in for the Feature D backend (the assertion surface), and holds `localhost:8078` down at 503 so tier-1 keyword classification decides every page. |
| `e2e/chromiumExtension.e2e.mjs` | Launches Chromium with the unpacked extension, drives real scroll/cursor input per page, and checks both what reached Feature D and what B committed to `chrome.storage.session`. |

Three things worth knowing:

- It needs **Playwright's bundled Chromium** (`npx playwright install chromium`). `--load-extension` was dropped from Chrome stable at 137, and 150 removed the enterprise bypass, so an installed Chrome can no longer load an unpacked extension from the command line.
- Only the two network edges are faked. Feature A extraction, Readability, colour sampling, `behaviorTracker`, and all of B1–B4 run for real in a real renderer.
- If the real classify proxy is already on `:8078`, the harness says so and downgrades the exact-mood expectations to advisory — an LLM is entitled to disagree with the keyword tier. Stop it for an assertable run.

It is deliberately not part of `npm test`: it takes ~2 minutes and needs a browser download.
