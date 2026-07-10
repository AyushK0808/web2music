# Web2Music

Web2Music is a Chrome extension that generates mood-adaptive ambient/background music in real time, based on the content and "feel" of the webpage you're currently browsing. It reads page text, colours, and browsing behaviour, classifies a mood, generates (or synthesises) matching audio, and plays it back — ducking automatically around existing media like YouTube or Spotify.

This repository unifies the project's four features, each originally developed on its own branch:

```
Feature A (Site Data Extraction)          → feature-a-data-extraction/
    │  Handoff 1: PageData (text, embedding, colours, behaviour)
    ▼
Feature B (Mood & Context Classification) → feature-b-mood-classification/
    │  Handoff 2: MusicProfile + audio prompt
    ▼
Feature D (AI Audio Generation)           → feature-d-audio-generation/
    │  Handoff 3: audio URL + metadata
    ▼
Feature C (Extension Shell & Playback)    → feature-c-extension/
```

## Modules

| Module | Feature | Stack | Role |
|---|---|---|---|
| [`feature-a-data-extraction/`](feature-a-data-extraction/README.md) | A | JavaScript | Extracts page text, a semantic embedding, and dominant colours from the DOM for use as classification input. |
| [`feature-b-mood-classification/`](feature-b-mood-classification/README.md) | B | JavaScript | Classifies mood from page content, colour, and scroll/cursor behaviour, then builds a music profile and text-to-audio prompt. |
| [`feature-d-audio-generation/`](feature-d-audio-generation/README.md) | D | Python (FastAPI) | Generates loopable ambient audio from the music profile using MusicGen, post-processes it, and caches results in Supabase. |
| [`feature-c-extension/`](feature-c-extension/README.md) | C | JavaScript (Chrome MV3) | The Chrome extension itself: content script, service worker, offscreen audio player (Tone.js), and popup UI. |

Each module has its own README with setup, API, and implementation details — start there for module-specific work. This document covers how the pieces fit together.

## Current integration status

`feature-c-extension/` is the extension that actually loads in Chrome. It runs a self-contained page-data extraction and playback pipeline today; the call out to a Feature D-style backend (`POST /profile`, `POST /generate` against `http://localhost:8000`) is wired but currently commented out in `background.js` pending integration with Feature B and D. `feature-a-data-extraction/` and `feature-b-mood-classification/` are the more fully-featured, independently-tested implementations of Features A and B and are the intended replacements for the extension's current inline logic.

## How to run each module

### Feature A — `feature-a-data-extraction/`
Not a standalone app — a set of content-script modules meant to be loaded into a browser context (bundled into `feature-c-extension/` or loaded ad hoc).

```bash
cd feature-a-data-extraction
# no install step for the core scripts; the local embedding backend needs:
npm install @xenova/transformers
```
Then load `Textextractor.js`, `Embeddingmodel.js`, and `Colorextractor.js` as content scripts (or bundle them) and call them as shown in the module's README.

### Feature B — `feature-b-mood-classification/`
A Node.js library with a test suite; also meant to be wired into the extension's background script.

```bash
cd feature-b-mood-classification
npm test                                  # runs the full B1–B4 + integration test suite

# optional: manual exploration scripts (Tier-2 LLM tests need an API key)
$env:ANTHROPIC_API_KEY="sk-ant-your-key"  # PowerShell
node manual_tests/try_tier_check.js
node manual_tests/try_real_site.js https://en.wikipedia.org/wiki/Indus_Valley_Civilisation
```

### Feature D — `feature-d-audio-generation/`
A standalone FastAPI server.

```bash
cd feature-d-audio-generation
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # Mac/Linux

pip install -r requirements.txt   # requires ffmpeg on PATH (needed by pydub)

# create a .env with SUPABASE_URL, SUPABASE_KEY, HF_TOKEN
uvicorn main:app --reload
```
Server runs at `http://127.0.0.1:8000`; Swagger UI at `http://127.0.0.1:8000/docs`. First request is slow (~1-2 min) while MusicGen loads.

### Feature C — `feature-c-extension/`
The Chrome extension. No build step.

```
1. Open chrome://extensions
2. Enable Developer mode
3. Load unpacked → select feature-c-extension/
4. Browse normally; open the extension popup to toggle playback and volume
```
To exercise the full pipeline, start Feature D's server first (`uvicorn main:app --reload` on port 8000) and uncomment the `fetchMusicProfile()` / `fetchAudioUrl()` calls in `feature-c-extension/background.js`.

## Repository layout

```
web2music/
├── feature-a-data-extraction/    # Feature A — text/embedding/colour extraction
├── feature-b-mood-classification/# Feature B — mood classification & prompt engineering
├── feature-d-audio-generation/   # Feature D — MusicGen audio generation backend
├── feature-c-extension/          # Feature C — the Chrome extension (MV3)
└── README.md                     # This file
```
