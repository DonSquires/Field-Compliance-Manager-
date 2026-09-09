FROM mcr.microsoft.com/playwright:v1.62.1-jammy

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir runpod

WORKDIR /opt/fcm-runpod-qa
COPY apps/web/package.json apps/web/package-lock.json /opt/fcm-runpod-qa/web/
RUN cd /opt/fcm-runpod-qa/web \
  && npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY runpod-qa-worker/handler.py /opt/fcm-runpod-qa/handler.py

ENV PYTHONUNBUFFERED=1
CMD ["python3", "/opt/fcm-runpod-qa/handler.py"]
