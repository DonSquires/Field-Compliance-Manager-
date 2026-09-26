#!/usr/bin/env bash
# Laptop side of Bob's GPU link (Linux/macOS/WSL). See laptop-link.ps1 for Windows.
# Keeps a reverse SSH tunnel so the VPS's fcm-api can reach this machine's Ollama
# as http://host.docker.internal:11435/v1. Forwarding-only; reconnects itself.
set -Eeuo pipefail

VPS_HOST="${BOB_GPU_LINK_HOST:-72.61.123.97}"
VPS_USER="${BOB_GPU_LINK_USER:-bobgpu}"
GATEWAY_IP="${BOB_GPU_LINK_GATEWAY:-172.16.0.1}"
REMOTE_PORT="${BOB_GPU_LINK_PORT:-11435}"
LOCAL_PORT="${OLLAMA_PORT:-11434}"
MODELS="${BOB_GPU_MODELS:-qwen2.5:7b,qwen2.5-coder:7b}"
# Ollama's default 4k window would truncate Bob's prompts silently.
CONTEXT_LENGTH="${BOB_GPU_CONTEXT_LENGTH:-32768}"
KEY="${HOME}/.ssh/bob-gpu-link"

log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

command -v ollama >/dev/null || { echo "Ollama is not installed (https://ollama.com/download)" >&2; exit 1; }

if [[ ! -f "$KEY" ]]; then
  mkdir -p "$(dirname "$KEY")"
  ssh-keygen -t ed25519 -f "$KEY" -N '' -C bob-gpu-link >/dev/null
  log "Generated a new key. Give this PUBLIC key to the VPS setup script:"
  cat "${KEY}.pub"
  log 'On the VPS: bash scripts/bob-gpu-link/vps-setup.sh "<paste the line above>"'
fi

if ! curl -fs "http://127.0.0.1:${LOCAL_PORT}/api/tags" >/dev/null 2>&1; then
  log "Starting Ollama (context ${CONTEXT_LENGTH}, models stay loaded 2h)"
  (OLLAMA_CONTEXT_LENGTH="$CONTEXT_LENGTH" OLLAMA_KEEP_ALIVE=2h OLLAMA_FLASH_ATTENTION=1 ollama serve >/dev/null 2>&1 &)
  sleep 4
fi
for model in ${MODELS//,/ }; do
  ollama list 2>/dev/null | grep -q "^${model}" || { log "Pulling ${model}"; ollama pull "$model"; }
done

log "Linking local Ollama :${LOCAL_PORT} -> ${VPS_USER}@${VPS_HOST} ${GATEWAY_IP}:${REMOTE_PORT} (Ctrl+C to stop)"
while true; do
  ssh -N \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    -i "$KEY" \
    -R "${GATEWAY_IP}:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" \
    "${VPS_USER}@${VPS_HOST}" || true
  log "Tunnel closed; reconnecting in 5 seconds."
  sleep 5
done
