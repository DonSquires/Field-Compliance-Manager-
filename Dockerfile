FROM node:22-alpine

# Builder workspaces, verified commits, and pushes need a real git binary; the
# docker CLI lets the control plane launch isolated verification workers via the
# host daemon socket (mounted by deploy/bob-control-plane/docker-compose.yml).
RUN apk add --no-cache git docker-cli

ENV NODE_ENV=production
ENV PORT=8080
ENV NODE_PATH=/opt/bob/node_modules

WORKDIR /opt/bob
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . /app
USER node

WORKDIR /app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/bob-control-plane-server.js"]