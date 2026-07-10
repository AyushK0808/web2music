# 🎵 Web2Music — Feature D: AI Audio Generation System

Part of the **Web2Music** Chrome Extension — a system that generates mood-adaptive background music based on the webpage you're browsing.

Feature D is the audio generation backend. It receives a music profile from Feature B (Mood & Context Classification), generates a loopable audio clip using MusicGen, post-processes it, caches it, and returns a URL + metadata to Feature C (Audio Playback Engine).

---

## Architecture Overview
Feature B ──► D1: Validate Profile ──► D2: Build Prompt ──► D3: Generate Audio (MusicGen)
│
Feature C ◄── D5: Return Audio ◄── D4: Cache & Store ◄── D3: Post-Process Audio
### Pipeline Steps

| File | Step | What it does |
|---|---|---|
| `d1_validate.py` | Receive & Validate | Validates incoming music profile, fills missing fields with defaults |
| `d2_prompt.py` | Prompt Engineering | Converts profile into a MusicGen-optimised text prompt |
| `d3_generate.py` | Audio Generation | Runs `facebook/musicgen-small` to generate ~28s of audio |
| `d4_process.py` | Post-Processing | Normalises volume, trims silence, detects loop point, exports mp3 |
| `d5_cache.py` | Cache & Store (prod) | Checks/writes Supabase cache to avoid regenerating similar audio |
| `d5_cache_local.py` | Cache & Store (dev) | Same cache logic against a local Docker Postgres + files on disk |
| `main.py` | FastAPI Server | `/generate` endpoint that orchestrates the full pipeline |

---

##  API

### `POST /generate`

Accepts a music profile JSON from Feature B and returns a loopable audio URL.

**Request body:**
```json
{
  "mood": "calm",
  "energy": 0.4,
  "bpm": 75,
  "key": "C major",
  "style": "ambient",
  "content_category": "general"
}
```

**Response:**
```json
{
  "audio_url": "https://your-supabase-url.../audio-cache/abc123.mp3",
  "metadata": {
    "mood": "calm",
    "bpm": 75,
    "key": "C major",
    "energy": 0.4,
    "loop_point_ms": 18400,
    "prompt_used": "calm ambient music, 75 bpm, C major, ...",
    "loopable": true
  },
  "cache": "miss",
  "timings": {
    "d1_validate_ms": 1,
    "d5_cache_check_ms": 120,
    "d2_prompt_ms": 0,
    "d3_generate_ms": 47800,
    "d4_process_ms": 3200,
    "d5_save_ms": 540
  }
}
```

**Cache hit** returns instantly with `"cache": "hit"` — no regeneration.

### Caching Logic

Two requests are treated as identical (cache hit) if they share the same:
- `mood` (exact match)
- `style` (exact match)
- `energy` rounded to 1 decimal place
- `bpm` bucket: `low` (<76), `mid` (76–100), `high` (≥101)

---

##  Setup

### Prerequisites
- Python 3.10+
- ffmpeg installed ([download here](https://ffmpeg.org/download.html)) — required by pydub
- **Dev** (default): [Docker](https://docs.docker.com/get-docker/) — runs a local Postgres cache, no external account needed
- **Prod** (`IS_PROD=true`): [Supabase](https://supabase.com) account with:
  - A table called `audio_cache`
  - A storage bucket called `audio-cache` (set to public)

### Installation

```bash
git clone https://github.com/AyushK0808/web2music.git
cd web2music/feature-d-audio-generation
python -m venv venv

# Windows
venv\Scripts\activate

# Mac/Linux
source venv/bin/activate

pip install -r requirements.txt
```

### Dev vs. Prod

`main.py` reads an `IS_PROD` flag to pick the cache backend:

| `IS_PROD` | Cache backend | Audio storage |
|---|---|---|
| unset / `false` (default) | `d5_cache_local.py` → local Postgres (Docker) | `./audio-cache/` on disk, served at `/audio-cache/...` by FastAPI |
| `true` | `d5_cache.py` → Supabase Postgres | Supabase Storage (`audio-cache` bucket), public URL |

**Dev (default):**
```bash
cd docker
docker compose up -d      # starts local Postgres on :5432, creates the audio_cache table
cd ..
uvicorn main:app --reload
```

**Prod:**
Create a `.env` file in the project root (never commit this) with:
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_anon_key
HF_TOKEN=your_huggingface_token
```bash
IS_PROD=true uvicorn main:app --reload
```

### Running the Server

```bash
uvicorn main:app --reload
```

Server runs at `http://127.0.0.1:8000`  
Swagger UI available at `http://127.0.0.1:8000/docs`

> ⚠️ First startup loads the MusicGen model (~1-2 mins). Subsequent requests are faster.

---

## 📁 Project Structure

```
feature-d-audio-generation/
├── d1_validate.py          # Profile validation & defaults
├── d2_prompt.py            # Prompt builder for MusicGen
├── d3_generate.py          # MusicGen audio generation
├── d4_process.py           # Audio post-processing & loop detection
├── d5_cache.py             # Supabase cache read/write (prod)
├── d5_cache_local.py       # Local Postgres + disk cache read/write (dev)
├── main.py                 # FastAPI app, IS_PROD switch & pipeline orchestration
├── docker/
│   ├── docker-compose.yml  # Local Postgres for the dev cache
│   └── init.sql            # Creates the audio_cache table
├── experiments/
│   ├── d1_prompt_ablation.py
│   ├── d2_loop_test.py
│   ├── d3_clip_length.py
│   └── d4_latency.py
├── fallback_clips/         # Pre-generated fallback audio files
├── audio-cache/            # Dev-only: generated mp3s (gitignored)
├── .env                    # Local secrets (never committed)
├── .gitignore
└── requirements.txt

```

##  Dependencies

| Package | Purpose |
|---|---|
| `fastapi` | API server |
| `uvicorn` | ASGI server |
| `transformers` | MusicGen model |
| `soundfile` | Audio read/write |
| `librosa` | Loop point detection |
| `pyloudnorm` | Volume normalisation |
| `pydub` | Silence trimming, mp3 export |
| `supabase` | Cache storage (prod) |
| `psycopg2-binary` | Cache storage (dev, local Postgres) |
| `python-dotenv` | Environment variables |

---

## Handoffs

| Handoff | From → To | Payload |
|---|---|---|
| Handoff 2 | Feature B → Feature D | Music profile JSON |
| Handoff 3 | Feature D → Feature C | Audio URL + metadata JSON |

---

##  Planned Improvements

- [ ] Retry logic & fallback clips for generation failures
- [ ] Fix NaN risk in loop-point detection
- [ ] Thread-pool blocking generation call
- [ ] Add `duration_seconds` to response metadata
- [ ] Pydantic model for request validation
- [ ] ogg format support alongside mp3
