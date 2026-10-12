#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="${BOB_VPS_HOST:-72.61.123.97}"
SSH_KEY="${BOB_VPS_SSH_KEY:-$HOME/.ssh/codespaces-kvm}"
VPS_KNOWN_HOSTS="${BOB_VPS_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
OWNER="${GITHUB_OWNER:-DonSquires}"
REPOSITORY="${GITHUB_REPO:-Field-Compliance-Manager-}"
API_TOKEN="${BOB_GITHUB_ACCESS_TOKEN:-}"
[[ -n "$API_TOKEN" ]] || { echo 'BOB_GITHUB_ACCESS_TOKEN is not injected into this Codespace; reopen it after adding the secret.' >&2; exit 2; }
if [[ ! -r "$SSH_KEY" ]]; then
  [[ -n "${CODESPACE_KVM:-}" ]] || { echo 'CODESPACE_KVM is not injected; reopen the Codespace after adding the secret.' >&2; exit 2; }
  install -d -m 0700 "$HOME/.ssh"
  umask 077
  printf '%s\n' "$CODESPACE_KVM" > "$SSH_KEY"
  chmod 0600 "$SSH_KEY"
fi
[[ -r "$SSH_KEY" ]] || { echo "VPS SSH identity is unreadable: $SSH_KEY" >&2; exit 2; }
[[ -s "$VPS_KNOWN_HOSTS" ]] || { echo "refusing SSH: VPS host key must be pinned in $VPS_KNOWN_HOSTS after independent fingerprint verification" >&2; exit 2; }

BOB_GITHUB_ACCESS_TOKEN="$API_TOKEN" GITHUB_OWNER="$OWNER" GITHUB_REPO="$REPOSITORY" \
  node -e "(async()=>{const token=process.env.BOB_GITHUB_ACCESS_TOKEN;const response=await fetch('https://api.github.com/repos/'+process.env.GITHUB_OWNER+'/'+process.env.GITHUB_REPO,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'bob-main-health-setup'}});if(response.status>=300){console.error('GitHub repository API authentication failed: HTTP '+response.status);process.exit(1)}const data=await response.json();if(data.permissions?.push!==true){console.error('GitHub API credential lacks repository push permission');process.exit(1)}console.log('GitHub API authentication and repository push permission verified')})().catch(error=>{console.error(error.message);process.exit(1)})"

ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$VPS_KNOWN_HOSTS" -o ConnectTimeout=15 "root@$VPS_HOST" \
  'runuser -u ubuntu -- env GIT_SSH_COMMAND="ssh -i /var/lib/bob/github/bob-fcm-main -o IdentitiesOnly=yes -o UserKnownHostsFile=/var/lib/bob/github/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10" git ls-remote git@github.com:DonSquires/Field-Compliance-Manager-.git refs/heads/main' \
  >/dev/null

printf '%s' "$API_TOKEN" | ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$VPS_KNOWN_HOSTS" "root@$VPS_HOST" \
  "python3 -c 'import os,pathlib,sys,tempfile; token=sys.stdin.read().strip(); p=pathlib.Path(\"/var/lib/bob/control-plane.env\"); updates={\"BOB_GITHUB_ACCESS_TOKEN\":token,\"GITHUB_OWNER\":\"$OWNER\",\"GITHUB_REPO\":\"$REPOSITORY\",\"BOB_GITHUB_SSH_KEY_FILE\":\"/data/github/bob-fcm-main\",\"BOB_GITHUB_KNOWN_HOSTS_FILE\":\"/data/github/known_hosts\",\"BOB_AUTOPILOT_AUTOMERGE\":\"true\",\"BOB_MAIN_HEALTH\":\"true\"}; lines=p.read_text().splitlines() if p.exists() else []; kept=[line for line in lines if line.split(\"=\",1)[0] not in updates]; kept.extend(k+\"=\"+v for k,v in updates.items()); fd,tmp=tempfile.mkstemp(prefix=\"control-plane.env.\",dir=str(p.parent)); f=os.fdopen(fd,\"w\"); f.write(\"\\n\".join(kept)+\"\\n\"); f.flush(); os.fsync(f.fileno()); f.close(); os.chmod(tmp,0o600); os.replace(tmp,p)'"

scripts/bob-vps-deploy.sh control-plane

curl -fsS --max-time 15 https://bob.fcmanager.co.nz/health | node -e "let input='';process.stdin.on('data',chunk=>input+=chunk).on('end',()=>{const health=JSON.parse(input);const ready=health.builderGitHost==='github'&&health.builderSshConfigured===true&&health.builderApiConfigured===true&&health.autopilot===true&&health.mainHealth?.enabled===true;console.log(JSON.stringify({builderGitHost:health.builderGitHost,builderSshConfigured:health.builderSshConfigured,builderApiConfigured:health.builderApiConfigured,autopilot:health.autopilot,mainHealth:health.mainHealth}));if(!ready)process.exit(1)})"