FROM python:3.12-slim

# WITH_DETECTOR=1 adds the person/vehicle/animal detector tier (ultralytics + torch, MegaDetector v5a
# weights, vehicle re-ID). The default image keeps the lighter OpenVINO-only footprint.
ARG WITH_DETECTOR=0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WITH_DETECTOR=${WITH_DETECTOR}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-detector.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$WITH_DETECTOR" = "1" ]; then pip install --no-cache-dir -r requirements-detector.txt; fi
COPY app.py ./
COPY detector.py ./
COPY download_models.py ./
COPY runpod_handler.py ./

RUN mkdir -p /app/models && python download_models.py

RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 3000
CMD ["python", "runpod_handler.py"]