FROM mcr.microsoft.com/playwright:v1.62.1-jammy

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir runpod

WORKDIR /opt/fcm-runpod-qa
COPY handler.py /opt/fcm-runpod-qa/handler.py

ENV PYTHONUNBUFFERED=1
CMD ["python3", "/opt/fcm-runpod-qa/handler.py"]
