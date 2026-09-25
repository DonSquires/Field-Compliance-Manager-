FROM node:22-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY video_motion_extractor.py capture_enhancement.py capture_derivative.py observation_derivatives.js vision_job_watcher.js local_jwt_signer.js motion_consolidator.js ./

RUN useradd --create-home --uid 10001 appuser
USER appuser
CMD ["node", "vision_job_watcher.js"]