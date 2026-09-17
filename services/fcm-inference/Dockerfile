# --- Stage 1: SpeciesNet checkpoint -> ONNX (torch lives only here) -------------------------------------------
# WITH_SPECIESNET=0 skips the species tier (faster dev builds); the runtime then reports species not_staged.
FROM python:3.12-slim AS speciesnet-export
ARG WITH_SPECIESNET=1
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MODELS_DIR=/export
WORKDIR /export
COPY download_models.py export_speciesnet_onnx.py ./
RUN mkdir -p /export/out && if [ "$WITH_SPECIESNET" = "1" ]; then \
      pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision \
      && pip install --no-cache-dir onnx onnx2torch onnxruntime onnxscript opencv-python-headless numpy pillow \
      && SPECIESNET_CHECKPOINT_ONLY=1 python download_models.py \
      && python export_speciesnet_onnx.py /export /export/out/speciesnet_v4.0.2a_always_crop.onnx \
      && cp /export/*.txt /export/*.json /export/out/ ; fi

# --- Stage 2: runtime ----------------------------------------------------------------------------------------
FROM python:3.12-slim

# GPU=1 installs onnxruntime-gpu (CUDA 12 / cuDNN 9 as pip packages) for RunPod serverless workers; the default
# GPU=0 image is the CPU tier that runs on the VPS. Both carry the same models (RF-DETR large + small, plate
# detector, plate OCR, SpeciesNet ONNX, OpenVINO attribute models), so the tier is chosen by the host, not by
# the build.
ARG GPU=0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    INFERENCE_GPU_IMAGE=${GPU} \
    MODELS_DIR=/app/models

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-onnxruntime-cpu.txt requirements-onnxruntime-gpu.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Separate layer: the GPU wheel set (CUDA 12 runtime + cuDNN 9) is ~2 GB and must stay its own registry blob.
RUN if [ "$GPU" = "1" ]; then pip install --no-cache-dir -r requirements-onnxruntime-gpu.txt; \
    else pip install --no-cache-dir -r requirements-onnxruntime-cpu.txt; fi

COPY download_models.py ./
RUN mkdir -p /app/models && python download_models.py
COPY --from=speciesnet-export /export/out/ /app/models/

COPY app.py detector.py plates.py species.py runpod_handler.py ./

RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 3000
CMD ["python", "runpod_handler.py"]
