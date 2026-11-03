# Feature D — audio generation backend (GPU / CUDA).
# Built from the repo root as build context (see docker-compose.yml).
# Requires the NVIDIA Container Toolkit on the host; run via the `gpu`
# compose profile (mutually exclusive with the `cpu` profile / feature-d.Dockerfile).
FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.12 python3-pip python3.12-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# W2M_MODEL picks the generator (musicgen-small | musicgen-medium | audioldm2-music);
# W2M_COMPILE=1 turns on torch.compile. Both are read once at start-up and are
# reported on /health, so every result file records what was timed.
ENV FFMPEG_BINARY=/usr/bin/ffmpeg \
    PYTHONUNBUFFERED=1 \
    W2M_MODEL=musicgen-small \
    W2M_COMPILE=0

WORKDIR /app

# CUDA-enabled torch build (cu128: Blackwell cards such as the RTX 5060 are sm_120 and need CUDA 12.8 wheels).
COPY audio-generation/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir torch==2.12.1 --index-url https://download.pytorch.org/whl/cu128 \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir diffusers accelerate

COPY audio-generation/ ./

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
