#!/usr/bin/env bash
# Makes the A100's private Ollama listener available only on this host.
set -Eeuo pipefail

readonly A100_HOST="${A100_HOST:-117.18.102.45}"
readonly A100_USER="${A100_USER:-ubuntu}"
readonly A100_SSH_PORT="${A100_SSH_PORT:-30817}"
readonly LOCAL_OLLAMA_PORT="${LOCAL_OLLAMA_PORT:-11434}"
readonly A100_OLLAMA_HOST="${A100_OLLAMA_HOST:-127.0.0.1}"
readonly A100_OLLAMA_PORT="${A100_OLLAMA_PORT:-11434}"
readonly RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
readonly CONTROL_SOCKET="${RUNTIME_DIR}/bob-a100-ollama-${A100_SSH_PORT}.sock"
readonly PID_FILE="${RUNTIME_DIR}/bob-a100-ollama-watch.pid"
readonly LOG_FILE="${RUNTIME_DIR}/bob-a100-ollama-watch.log"

readonly -a SSH_OPTIONS=(
  -p "${A100_SSH_PORT}"
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ExitOnForwardFailure=yes
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=yes
  -o ControlMaster=yes
  -o "ControlPath=${CONTROL_SOCKET}"
)

log() {
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

tunnel_is_alive() {
  ssh "${SSH_OPTIONS[@]}" -S "${CONTROL_SOCKET}" -O check \
    "${A100_USER}@${A100_HOST}" >/dev/null 2>&1
}

start_tunnel() {
  rm -f "${CONTROL_SOCKET}"

  # This runs on the KVM: -L binds locally and reaches Ollama on the A100.
  ssh -N -f "${SSH_OPTIONS[@]}" \
    -L "127.0.0.1:${LOCAL_OLLAMA_PORT}:${A100_OLLAMA_HOST}:${A100_OLLAMA_PORT}" \
    "${A100_USER}@${A100_HOST}"
}

stop_tunnel() {
  ssh "${SSH_OPTIONS[@]}" -S "${CONTROL_SOCKET}" -O exit \
    "${A100_USER}@${A100_HOST}" >/dev/null 2>&1 || true
  rm -f "${CONTROL_SOCKET}"
}

watch_tunnel() {
  exec 9>"${PID_FILE}.lock"
  flock -n 9 || {
    log "tunnel watcher is already running"
    exit 0
  }

  printf '%s\n' "$$" >"${PID_FILE}"
  trap 'stop_tunnel; rm -f "${PID_FILE}"' EXIT INT TERM

  while true; do
    if ! tunnel_is_alive; then
      log "starting A100 Ollama tunnel on 127.0.0.1:${LOCAL_OLLAMA_PORT}"
      if ! start_tunnel; then
        log "tunnel start failed; retrying in 5 seconds"
      fi
    fi
    sleep 5
  done
}

if [[ "${1:-}" == "--watch" ]]; then
  watch_tunnel
fi

if [[ -f "${PID_FILE}" ]] && kill -0 "$(<"${PID_FILE}")" 2>/dev/null; then
  log "tunnel watcher is already running (PID $(<"${PID_FILE}"))"
  exit 0
fi

nohup bash "$0" --watch >>"${LOG_FILE}" 2>&1 < /dev/null &
log "tunnel watcher started (PID $!, log: ${LOG_FILE})"