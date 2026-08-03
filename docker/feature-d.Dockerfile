# Feature D — audio generation backend (CPU).
# Built from the repo root as build context (see docker-compose.yml).
FROM python:3.12-slim

# ffmpeg is installed for its libopus support -- d4_process.py normally uses
# the static binary bundled with imageio-ffmpeg (no install needed), but
# that bundled binary isn't guaranteed to carry libopus on every platform.
# FFMPEG_BINARY (set below) points pydub at this apt-installed copy instead,
# which debian's build does carry it on.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV FFMPEG_BINARY=/usr/bin/ffmpeg \
    PYTHONUNBUFFERED=1

WORKDIR /app

# CPU-only torch wheel -- the default PyPI wheel pulls CUDA runtime
# libraries that are dead weight (and multiple GB) on a CPU-only image.
COPY audio-generation/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir torch==2.12.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

COPY audio-generation/ ./

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
