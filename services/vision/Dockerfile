FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY video_motion_extractor.py vision_job_watcher.js ./

RUN useradd --create-home --uid 10001 appuser
USER appuser
CMD ["node", "vision_job_watcher.js"]