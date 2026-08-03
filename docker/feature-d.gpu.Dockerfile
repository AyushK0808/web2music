# Feature D — audio generation backend (GPU / CUDA).
# Built from the repo root as build context (see docker-compose.yml).
# Requires the NVIDIA Container Toolkit on the host; run via the `gpu`
# compose profile (mutually exclusive with the `cpu` profile / feature-d.Dockerfile).
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.12 python3-pip python3.12-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV FFMPEG_BINARY=/usr/bin/ffmpeg \
    PYTHONUNBUFFERED=1

WORKDIR /app

# CUDA-enabled torch build (cu124 matches the base image's CUDA 12.4).
COPY audio-generation/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir torch==2.12.1 --index-url https://download.pytorch.org/whl/cu124 \
    && pip install --no-cache-dir -r requirements.txt

COPY audio-generation/ ./

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
