# 🎵 Web2Music — Feature D: AI Audio Generation System

Part of the **Web2Music** Chrome Extension — a system that generates mood-adaptive background music based on the webpage you're browsing.

Feature D is the audio generation backend. It receives a music profile from Feature B (Mood & Context Classification), generates a loopable audio clip using MusicGen, post-processes it, caches it, and returns a URL + metadata to Feature C (Audio Playback Engine). If generation fails at any stage, it falls back to a pre-generated clip for the requested mood rather than erroring out.

---

## Architecture Overview
Feature B ──► D1: Validate Profile ──► D2: Build Prompt ──► D3: Generate Audio (MusicGen)
│
Feature C ◄── D5: Cache & Return ◄── D4: Post-Process Audio
(falls back to a pre-generated clip if D3, D4, or D5 fails)

### Pipeline Steps

| File | Step | What it does |
|---|---|---|
| `d1_validate.py` | Receive & Validate | Validates incoming music profile (Pydantic), fills missing fields with defaults |
| `d2_prompt.py` | Prompt Engineering | Converts profile into a MusicGen-optimised text prompt |
| `d3_generate.py` | Audio Generation | Runs `facebook/musicgen-small` to generate audio; batches concurrent requests; retries on failure |
| `d4_process.py` | Post-Processing | Normalises volume, trims silence, detects loop point, exports Ogg/Opus |
| `d5_cache.py` | Cache & Store (prod) | Checks/writes Supabase cache to avoid regenerating similar audio |
| `d5_cache_local.py` | Cache & Store (dev) | Same cache logic against a local Docker Postgres + files on disk |
| `fallback.py` | Fallback (dev) | Serves a pre-generated clip from local disk if generation fails |
| `fallback_prod.py` | Fallback (prod) | Serves a pre-generated clip from the Supabase `fallback_clips` table if generation fails |
| `generate_fallbacks.py` | Fallback setup | One-time script to pre-generate the 11 mood fallback clips |
| `main.py` | FastAPI Server | `/generate` endpoint that orchestrates the full pipeline |

---

## API

### `POST /generate`

Accepts a music profile JSON from Feature B and returns a loopable audio URL. All fields are optional — omitted fields fall back to `MusicProfile`'s defaults (see `models.py`).

**Request body:**
```json
{
  "mood": "calm",
  "energy": 0.4,
  "bpm": 75,
  "key": "C major",
  "style": "ambient",
  "valence": 0.2,
  "arousal": 0.4,
  "intensity": 0.3,
  "duration_seconds": 15,
  "content_category": "general"
}
```

**Response (cache miss / fresh generation):**
```json
{
  "audio_url": "https://your-supabase-url.../audio-cache/abc123.ogg",
  "metadata": {
    "cache_key": "abc123...",
    "mood": "calm",
    "bpm": 75,
    "key": "C major",
    "energy": 0.4,
    "valence": 0.2,
    "intensity": 0.3,
    "duration_seconds": 15,
    "loop_point_ms": 18400,
    "seam_discontinuity": {
      "energy_delta_db": 2.1,
      "spectral_centroid_delta_hz": 480.0
    },
    "prompt_used": "calm ambient music, 75 bpm, C major, ...",
    "prompt_source": "feature_b",
    "generation_seed": 43,
    "is_fallback": false,
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

**Cache hit** returns instantly with `"cache": "hit"` — same shape as above, no regeneration.

**Fallback response** (generation/processing/save failed, or malformed input): returns `"is_fallback": true`, `"fallback": true`, and `"prompt_source": "fallback_clip"`, with `audio_url` pointing at a pre-generated clip for the closest matching mood instead of a freshly generated one.

### Caching Logic

Two requests are treated as identical (cache hit) if they share the same:
- `mood` (exact match)
- `style` (exact match)
- `key` (exact match)
- `energy` rounded to 1 decimal place
- `valence` rounded to 1 decimal place
- `arousal` rounded to 1 decimal place
- `bpm` bucket: `low` (<76), `mid` (76–100), `high` (≥101)
- `duration_seconds` bucket (paired into 2s buckets: 28 & 29 → 28, 30 & 31 → 30)
- export codec (so a codec change invalidates old cache entries automatically)

`seed` is intentionally excluded from the cache key — each retry attempt uses a different seed, and including it would defeat caching entirely.

### Fallback Behaviour

If D3 (generation), D4 (post-processing), or D5 (cache save) fails — or if the incoming profile fails validation — `/generate` returns a pre-generated fallback clip instead of a 500. There are 11 fallback clips, one per supported mood, generated once via `generate_fallbacks.py`. If no clip matches the requested mood, it falls back through `neutral` → `calm` → `focused` in order. Only if *no* fallback clips exist at all does the endpoint return a `503`.

---

## Setup

### Prerequisites
- Python 3.10+
- ffmpeg installed ([download here](https://ffmpeg.org/download.html)) — required by pydub
- **Dev** (default): [Docker](https://docs.docker.com/get-docker/) — runs a local Postgres cache, no external account needed
- **Prod** (`IS_PROD=true`): [Supabase](https://supabase.com) account with:
  - A table called `audio_cache` (see `docker/init.sql` for schema; RLS must allow inserts from your app's key, or be disabled for this table)
  - A storage bucket called `audio-cache` (set to public)
  - A table called `fallback_clips` (`mood` PK, `audio_url`, `loop_point_ms`, `seam_discontinuity`, `prompt_used`, `generation_seed`)
  - A storage bucket called `fallback-clips` (set to public)

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

`main.py` reads an `IS_PROD` flag to pick the cache and fallback backends:

| `IS_PROD` | Cache backend | Audio storage | Fallback source |
|---|---|---|---|
| unset / `false` (default) | `d5_cache_local.py` → local Postgres (Docker) | `./audio-cache/` on disk, served at `/audio-cache/...` by FastAPI | `fallback.py` → local disk, served at `/fallback-clips/...` |
| `true` | `d5_cache.py` → Supabase Postgres | Supabase Storage (`audio-cache` bucket), public URL | `fallback_prod.py` → Supabase `fallback_clips` table |

**Dev (default):**
```bash
cd docker
docker compose up -d      # starts local Postgres on :5432, creates the audio_cache table
cd ..
uvicorn main:app --reload
```

**Prod:**
Create a `.env` file in the project root (never commit this) with:
```
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_anon_key
HF_TOKEN=your_huggingface_token
IS_PROD=true
```
```bash
uvicorn main:app --reload
```
(With `IS_PROD=true` in `.env`, plain `uvicorn main:app --reload` is enough — no need to set it inline on the command line. On Windows cmd, `IS_PROD=true uvicorn ...` doesn't work; use `set IS_PROD=true && uvicorn main:app --reload` or set it in `.env` instead.)

**Generating fallback clips** (one-time, or whenever fallback profiles change):
```bash
python generate_fallbacks.py
```
Run once in dev to populate `fallback_clips/` locally. Run again with `IS_PROD=true` set to also upload each clip + its metadata to the Supabase `fallback-clips` bucket and `fallback_clips` table.

### Running the Server

```bash
uvicorn main:app --reload
```

Server runs at `http://127.0.0.1:8000`  
Swagger UI available at `http://127.0.0.1:8000/docs`

> ⚠️ First startup loads the MusicGen model (~1-2 mins). Subsequent requests are faster.

> **⚠️ Deployment note:** `POST /generate` currently has no auth or
> rate-limiting. Each cache-miss request triggers a real MusicGen
> inference pass (real compute cost, plus Supabase storage/egress on
> save) with no restriction on who can call it or how often. This is a
> straightforward cost-based denial-of-service vector on any publicly
> reachable deployment — fine for local dev, but auth (API key / gateway)
> and rate-limiting need to land before this is exposed beyond
> localhost.

---

## 📁 Project Structure
'''
feature-d-audio-generation/

├── d1_validate.py # Profile validation & defaults

├── d2_prompt.py # Prompt builder for MusicGen

├── d3_generate.py # MusicGen audio generation (batched, async, retries)

├── d4_process.py # Audio post-processing & loop detection

├── d5_cache.py # Supabase cache read/write (prod)

├── d5_cache_local.py # Local Postgres + disk cache read/write (dev)

├── fallback.py # Local-disk fallback clip lookup (dev)

├── fallback_prod.py # Supabase table fallback clip lookup (prod)

├── generate_fallbacks.py # One-time script to pre-generate fallback clips

├── main.py # FastAPI app, IS_PROD switch & pipeline orchestration

├── models.py # Pydantic request/profile models

├── prewarm.py # Pre-warms the cache with a grid of common profiles at startup

├── docker/

│ ├── docker-compose.yml # Local Postgres for the dev cache

│ └── init.sql # Creates the audio_cache table

├── experiments/

│ ├── d1_prompt_ablation.py

│ ├── d2_loop_test.py

│ ├── d3_clip_length.py

│ └── d4_latency.py

├── fallback_clips/ # Pre-generated fallback audio + metadata sidecars (dev)

├── audio-cache/ # Dev-only: generated .ogg files (gitignored)

├── .env # Local secrets (never committed)

├── .gitignore

└── requirements.txt
'''

## Dependencies

| Package | Purpose |
|---|---|
| `fastapi` | API server |
| `uvicorn` | ASGI server |
| `transformers` | MusicGen model |
| `soundfile` | Audio read/write |
| `librosa` | Loop point detection |
| `pyloudnorm` | Volume normalisation |
| `pydub` | Silence trimming, Ogg/Opus export |
| `supabase` | Cache & fallback storage (prod) |
| `psycopg2-binary` | Cache storage (dev, local Postgres) |
| `python-dotenv` | Environment variables |

---

## Handoffs

| Handoff | From → To | Payload |
|---|---|---|
| Handoff 2 | Feature B → Feature D | Music profile JSON |
| Handoff 3 | Feature D → Feature C | Audio URL + metadata JSON |

---

## Known Gaps / Planned Improvements

- [ ] No auth or rate-limiting on `/generate` (see deployment note above)
- [ ] Fix NaN risk in loop-point detection
- [ ] Per-clip seeds within a batched generation call (currently one seed shared per batch)
- [ ] Benchmark `torch.compile` across varying prompt lengths (recompilation on shape change may erase the speedup)
- [ ] Automated tests for Pydantic models
- [ ] Longer / extendable audio (MusicGen continuation, or clips that resolve toward their own start)
- [ ] Fine-tuned adapter switch (`USE_FINETUNED`) alongside stock MusicGen baseline

