FROM node:22-alpine

WORKDIR /app
COPY worker.mjs /app/worker.mjs
COPY source-sync.mjs /app/source-sync.mjs

RUN mkdir /state && chown node:node /state

USER node
CMD ["node", "/app/worker.mjs"]
