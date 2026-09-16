FROM python:3.12-slim

# GPU=1 installs onnxruntime-gpu (CUDA 12 / cuDNN 9 as pip packages) for RunPod serverless workers; the default
# GPU=0 image is the CPU tier that runs on the VPS. Both carry the same models (RF-DETR large + small, plate
# detector, plate OCR, OpenVINO attribute models), so the tier is chosen by the host, not by the build.
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
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$GPU" = "1" ]; then pip install --no-cache-dir -r requirements-onnxruntime-gpu.txt; \
       else pip install --no-cache-dir -r requirements-onnxruntime-cpu.txt; fi

COPY download_models.py ./
RUN mkdir -p /app/models && python download_models.py

COPY app.py detector.py plates.py runpod_handler.py ./

RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 3000
CMD ["python", "runpod_handler.py"]
