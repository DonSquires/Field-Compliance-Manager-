#!/usr/bin/env bash
# VPS side of Bob's GPU link (run once as root on the KVM).
#
# The owner's laptop GPU runs Ollama for Bob's verifier/subagent roles. Laptops
# sit behind NAT, so the LAPTOP dials in and keeps a reverse SSH tunnel that lands
# its Ollama on the docker gateway address of this host. fcm-api reaches it as
# http://host.docker.internal:11435/v1 (see docker-compose.full.yml) and falls
# back to OpenAI on its own when the laptop is off.
#
# Security posture: a dedicated no-shell user, key-only, forwarding-only, and the
# listen address pinned to the docker gateway (never a public interface).
#
# Usage: bash scripts/bob-gpu-link/vps-setup.sh "<laptop ed25519 public key line>"
set -Eeuo pipefail

PUBKEY="${1:-}"
LINK_USER="${BOB_GPU_LINK_USER:-bobgpu}"
LINK_PORT="${BOB_GPU_LINK_PORT:-11435}"
if [[ -z "$PUBKEY" || ! "$PUBKEY" =~ ^ssh-(ed25519|rsa)\  ]]; then
  echo "usage: $0 \"ssh-ed25519 AAAA... bob-gpu-link\"" >&2
  exit 2
fi

GATEWAY_IP="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)"
echo "docker gateway address: ${GATEWAY_IP}"

if ! id "$LINK_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/${LINK_USER}" --shell /usr/sbin/nologin "$LINK_USER"
fi
install -d -m 700 -o "$LINK_USER" -g "$LINK_USER" "/var/lib/${LINK_USER}/.ssh"
# restrict = no pty/agent/X11/user-rc; only the one remote listen is permitted.
printf 'restrict,port-forwarding,permitlisten="%s:%s" %s\n' "$GATEWAY_IP" "$LINK_PORT" "$PUBKEY" > "/var/lib/${LINK_USER}/.ssh/authorized_keys"
chown "$LINK_USER:$LINK_USER" "/var/lib/${LINK_USER}/.ssh/authorized_keys"
chmod 600 "/var/lib/${LINK_USER}/.ssh/authorized_keys"

install -d -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/bob-gpu-link.conf <<EOF
# Bob GPU link: reverse-forward only, pinned to the docker gateway address.
Match User ${LINK_USER}
    AllowTcpForwarding remote
    GatewayPorts clientspecified
    PermitListen ${GATEWAY_IP}:${LINK_PORT}
    PermitOpen none
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PasswordAuthentication no
    ForceCommand /bin/false
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

# The docker gateway address is host-only; make sure nothing external can reach the port anyway.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw deny in on "$(ip -o -4 route show to default | awk '{print $5}' | head -1)" to any port "$LINK_PORT" proto tcp >/dev/null || true
fi

cat <<EOF

Bob GPU link is ready on this host.
Laptop connection (scripts/bob-gpu-link/laptop-link.ps1 or .sh does this for you):
  ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \\
      -i ~/.ssh/bob-gpu-link -R ${GATEWAY_IP}:${LINK_PORT}:127.0.0.1:11434 ${LINK_USER}@$(hostname -I | awk '{print $1}')

Verify from the VPS once the laptop is connected:
  curl -s http://${GATEWAY_IP}:${LINK_PORT}/v1/models | head -c 300
  curl -s -H "Authorization: Bearer \$API_TOKEN" http://127.0.0.1:3001/api/bob/health
EOF
