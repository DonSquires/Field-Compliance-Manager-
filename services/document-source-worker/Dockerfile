FROM node:22-alpine

WORKDIR /app
COPY worker.mjs /app/worker.mjs

USER node
CMD ["node", "/app/worker.mjs"]
