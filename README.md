# Web2Music

Web2Music is a Chrome extension that generates mood-adaptive ambient/background music in real time, based on the content and "feel" of the webpage you're currently browsing. It reads page text, colours, and browsing behaviour, classifies a mood, generates (or synthesises) matching audio, and plays it back — ducking automatically around existing media like YouTube or Spotify.

This repository is a monorepo unifying the project's four features, each originally developed on its own branch, plus shared infrastructure at the root:

```
Feature A (Site Data Extraction)          → data-extraction/
    │  Handoff 1: PageData (text, embedding, colours, behaviour)
    ▼
Feature B (Mood & Context Classification) → mood-classification/
    │  Handoff 2: MusicProfile + audio prompt
    ▼
Feature D (AI Audio Generation)           → audio-generation/
    │  Handoff 3: audio URL + metadata
    ▼
Feature C (Extension Shell & Playback)    → ui/
```

## Modules

| Module | Feature | Stack | Role |
|---|---|---|---|
| [`data-extraction/`](data-extraction/README.md) | A | JavaScript | Extracts page text, a semantic embedding, and dominant colours from the DOM for use as classification input. |
| [`mood-classification/`](mood-classification/README.md) | B | JavaScript | Classifies mood from page content, colour, and scroll/cursor behaviour, then builds a music profile and text-to-audio prompt. |
| [`audio-generation/`](audio-generation/README.md) | D | Python (FastAPI) | Generates loopable ambient audio from the music profile using MusicGen, post-processes it, and caches results (local Postgres in dev, Supabase in prod). |
| [`ui/`](ui/README.md) | C | JavaScript (Chrome MV3) | The Chrome extension itself: content script, service worker, offscreen audio player (Tone.js), and popup UI. |

Two supporting microservices, and the shared infra that runs everything:

| Path | Role |
|---|---|
| [`services/embed/`](services/embed/README.md) | Containerised OpenAI embedding proxy for Feature A — keeps the key out of the browser. `research` profile only; the extension itself vendors a local embedding model. |
| [`services/classify/`](services/classify/README.md) | Containerised GroqCloud chat-completions proxy for Feature B — keeps the key out of the browser. |
| [`docker/`](docker/docker-compose.yml) | The single Docker Compose file (with `cpu`/`gpu`/`research` profiles) and Dockerfiles for the whole stack, plus `init.sql` for the dev cache DB schema. |

## Current integration status

`ui/` is wired to the real A→B→D pipeline (X4): `npm run build` bundles Feature A's extractors + a locally-vendored MiniLM embedder into the content script and offscreen document, Feature B's classifier into the service worker, and a Feature D client with abort-on-stale-mood + instant-fallback-then-swap into the offscreen playback engine. Load `ui/dist/` (not `ui/`) as an unpacked extension after building. `audio-generation/` needs `fallback_clips/*.ogg` generated once (`python generate_fallbacks.py`) before the fallback path has anything to serve, and `services/classify/` running locally for Feature B's LLM calls. Each module can still be run and tested standalone as described below.

## Setup

One-time, from the repo root:

```bash
cp .env.example .env      # fill in at least GROQ_API_KEY (get one free at console.groq.com/keys)
npm install                # installs all workspaces: ui/, data-extraction/, mood-classification/, services/*
npm run up                  # docker compose up -d — starts Postgres + the classify-service proxy
                            # (add --profile cpu, or set COMPOSE_PROFILES=cpu in .env, to also start Feature D)
```

Then, per module:

### Feature A — `data-extraction/`
Not a standalone app — a set of content-script modules meant to be loaded into a browser context (bundled into `ui/` or loaded ad hoc).

```bash
npm run test:a     # or: cd data-extraction && npm test
```

### Feature B — `mood-classification/`
A Node.js library with a test suite; also meant to be wired into the extension's background script.

```bash
npm run test:b     # or: cd mood-classification && npm test

# optional: manual exploration scripts (Tier-2 LLM tests need an API key)
$env:ANTHROPIC_API_KEY="sk-ant-your-key"  # PowerShell
node mood-classification/manual_tests/try_tier_check.js
node mood-classification/manual_tests/try_real_site.js https://en.wikipedia.org/wiki/Indus_Valley_Civilisation
```

### Feature D — `audio-generation/`
A standalone FastAPI server. Either natively:

```bash
cd audio-generation
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # Mac/Linux

pip install -r requirements.txt   # requires ffmpeg on PATH (needed by pydub)
uvicorn main:app --reload
```

or via Docker (no local Python/ffmpeg needed):

```bash
docker compose -f docker/docker-compose.yml --profile cpu up feature-d
# --profile gpu instead, for the CUDA image
```

Server runs at `http://127.0.0.1:8000`; Swagger UI at `http://127.0.0.1:8000/docs`. First request is slow (~1-2 min) while MusicGen loads.

### Feature C — `ui/`
The Chrome extension.

```bash
npm run build       # bundles A + B + the extension shell into ui/dist/
```
```
1. Open chrome://extensions
2. Enable Developer mode
3. Load unpacked → select ui/dist/
4. Browse normally; open the extension popup to toggle playback and volume
```

Two browser-driven suites, both opt-in (neither is part of `npm test` — each takes a couple of minutes and needs Playwright's Chromium):

```bash
npm run test:e2e         # 12 synthetic pages: asserts which mood B picks and hands to D
npm run test:e2e:live    # real websites: asserts that music actually plays, ducks, and goes quiet
```

`test:e2e:live` browses Wikipedia, Hacker News and youtube.com with the extension loaded and measures the offscreen document's analyser to prove sound is really reaching the output — playback, the popup's mute button, ducking behind a real media tab, a mood change across pages, and the sensitive-page silence path. It needs network access; see [`ui/README.md`](ui/README.md#live-playback-tests).

## Repository layout

```
web2music/
├── package.json           # npm workspaces root
├── .env.example            # every env var the repo reads, in one place
├── docker/                 # shared Docker Compose + Dockerfiles + init.sql
├── services/
│   ├── embed/               # Feature A's OpenAI embedding proxy
│   └── classify/             # Feature B's GroqCloud proxy
├── data-extraction/         # Feature A — text/embedding/colour extraction
├── mood-classification/     # Feature B — mood classification & prompt engineering
├── audio-generation/        # Feature D — MusicGen audio generation backend
├── ui/                       # Feature C — the Chrome extension (MV3)
└── README.md                 # This file
```
