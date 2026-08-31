FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev
COPY assessment-manifest.js /app/assessment-manifest.js
COPY bob-control-plane-server.js /app/bob-control-plane-server.js
COPY backend-database-verifier.js /app/backend-database-verifier.js
COPY backend-worker.js /app/backend-worker.js
COPY builder-backend-handoff.js /app/builder-backend-handoff.js
COPY builder-frontend-handoff.js /app/builder-frontend-handoff.js
COPY builder-frontend-orchestrator.js /app/builder-frontend-orchestrator.js
COPY builder-model-gateway.js /app/builder-model-gateway.js
COPY builder-runtime-coordinator.js /app/builder-runtime-coordinator.js
COPY builder-security-handoff.js /app/builder-security-handoff.js
COPY browser-verifier.js /app/browser-verifier.js
COPY frontend-worker.js /app/frontend-worker.js
COPY security-worker.js /app/security-worker.js
COPY supabase-workflow-client.js /app/supabase-workflow-client.js
COPY scripts/atlas-graph.js /app/scripts/atlas-graph.js
COPY supabase/functions/_shared /app/supabase/functions/_shared

RUN addgroup -S bob && adduser -S bob -G bob
USER bob

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/bob-control-plane-server.js"]