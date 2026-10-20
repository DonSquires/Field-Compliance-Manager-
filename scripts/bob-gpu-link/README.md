# Bob's in-house compute: the GPU link

Bob works on his own compute first — your laptop's GPU when it is connected,
the VPS otherwise — and only outsources a step to OpenAI when he is stuck
(the local model is unreachable, the prompt does not fit its context window,
or its output fails verification). Every model run records which provider did
the work, so the cost split is auditable (`builder_model_runs.provider`).

## What runs where

| Role | First choice | Then | Last resort |
|---|---|---|---|
| Chat planner / drafting, synthesis | laptop GPU (`qwen2.5-coder:7b`) | — | OpenAI (`gpt-5.4`) |
| Chat verifier (critic), research subagents | laptop GPU (`qwen2.5:7b`, never the planner's model) | — | OpenAI (`gpt-5.4-mini`) |
| Builder author (writes the code) | memory-eligible laptop GPU model | VPS Ollama, then Ollama Cloud | OpenAI |
| Builder independent reviewer | distinct memory-eligible laptop GPU model | VPS Ollama, then Ollama Cloud | OpenAI |
| Builder analyst / UX / release notes | memory-eligible laptop GPU model | VPS Ollama, then Ollama Cloud | OpenAI |
| Light / restricted-data work (classification, summaries) | laptop GPU | VPS Ollama (`llama3.1:8b`, CPU) | OpenAI (never for restricted data) |
| Embeddings, image/vision helpers | VPS Ollama | — | — |

The reviewer is always a different model identity from the author (checked in
the database when the review is recorded).

The VPS has no GPU. Its Ollama runs on CPU (~13 tokens/s on an 8B model), fine
for the Builder reviewer, which has minutes to answer, but too slow for a chat
turn — so the chat lane skips it unless you set `BOB_ROUTE_*` to include
`vps_ollama`.

## Connect the laptop (Windows) — Tailscale

The VPS (`fcm-vps`, 100.85.95.104) and the laptop (`fcm-gpu-laptop`,
100.114.240.13) are on the same private Tailscale network, so the VPS reaches
the laptop's own Ollama directly — no tunnel. Once, in an **Administrator**
PowerShell on the laptop, from a checkout of this repository (`git pull` first):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-tailscale.ps1
```

It makes the existing Ollama listen for the VPS (32k context, 5 min keep-alive,
one loaded model and one parallel request),
pulls `qwen2.5:7b` and `qwen2.5-coder:7b` (~9 GB), opens port 11434 to the
Tailscale network only, and sets up **Bob's terminal** (below). Add
`-BiggerModels` for `qwen2.5-coder:14b` and `qwen3-coder:30b` only if the GPU has
the room. Installation is not eligibility to run: the gateway checks model file sizes.
Run it again only at an approved maintenance boundary: changing Ollama settings may restart it.

The VPS side already points at the laptop:
`GPU_WORKSTATION_URL=http://100.114.240.13:11434` (control plane) and
`…/v1` (fcm-api). Within a minute of the script finishing,
`/health` shows `gpu_workstation.healthy: true` and Bob's chat and Builder
work start landing on the laptop.

### Bob's terminal on the laptop

Owner instruction (2026-09-26): Bob may use Windows PowerShell on the laptop
to read files and do setup **when the owner wants him to**. The same script
installs Windows' built-in OpenSSH Server, makes PowerShell its shell,
authorises Bob's public key (`deploy/bob-laptop/bob_laptop_id_ed25519.pub`;
the private key never leaves the VPS's `/var/lib/bob/laptop/`), and opens
port 22 to the **VPS's Tailscale address only**.

- `laptop-tailscale.ps1 -Deny` — Bob cannot reach the laptop at all.
- `laptop-tailscale.ps1 -Allow` — Bob may run commands you approve in chat.
- `laptop-tailscale.ps1 -Status` — what is on.

In chat, Bob shows the exact command and runs it only after you say yes. The
control plane refuses destructive or privilege-changing commands outright
(`bob-laptop-shell.js`), caps and redacts the output, and records each run
(command head + hash, never the output). The script **registers the laptop
with Bob** each time it runs (Windows user name, Tailscale address, whether the
switch is on, models present) through the Supabase settings already in
`deploy/laptop-worker/laptop-worker.env` — nothing to copy across.
`BOB_LAPTOP_SSH_USER` / `BOB_LAPTOP_HOST` in `/var/lib/bob/control-plane.env`
pin values instead if ever needed. Optional overrides in `laptop-worker.env`:
`BOB_VPS_TAILSCALE_IP`, `BOB_GPU_MODELS` (comma-separated).

### Fallback without Tailscale: reverse SSH tunnel

`laptop-link.ps1` / `laptop-link.sh` + `vps-setup.sh` hold a forwarding-only
tunnel that lands the laptop's Ollama on the VPS at `host.docker.internal:11435`
(set `GPU_WORKSTATION_URL` accordingly). Kept for machines that cannot join
the tailnet.

## Check it

```bash
# VPS: which providers Bob can reach right now, and the model each would use
curl -s http://172.16.0.1:8091/health | jq .modelProviders
curl -s -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3001/api/bob/health | jq .bob
# measure a provider
node scripts/bob-gpu-link/ollama-bench.mjs http://127.0.0.1:11434 qwen2.5-coder:7b
```

### Tested laptop-to-VPS Docker route

Verified 2026-10-11 from `fcm-gpu-laptop` (`100.114.240.13`) to `fcm-vps`
(`100.85.95.104`):

- Tailscale reported both peers online.
- Batch-mode SSH succeeded as the existing deployment user with
  `~/.ssh/fcm-vps-deploy`; no password or token was printed.
- The remote Docker server answered and reported the FCM API, Bob control
  plane, inference, vision watcher, worker, Ollama and Gitea containers.
- Bob control-plane health reported the laptop shell enabled/configured, the
  GPU workstation healthy, and VPS Ollama healthy.

Use the checked wrapper from Windows:

```powershell
# SSH + Docker + control-plane + inference health
.\scripts\bob-vps-docker.ps1

# Docker inventory
.\scripts\bob-vps-docker.ps1 -Action Docker

# An explicit remote diagnostic or validation command
.\scripts\bob-vps-docker.ps1 -Action Command -Command 'docker logs --tail 50 fcm-inference'
```

The wrapper defaults to the private Tailscale address and refuses a non-tailnet
IPv4 target. It contains no credentials; it uses the existing deployment key.
It is the fallback validation path when Docker Desktop on the laptop is
unhealthy. Migration application, production deployment, secret changes and
other protected effects still require an explicit approved invocation; private
network reachability is not permission to bypass those gates.

### Updating the VPS inference image through the private route

Verified 2026-10-11 while adding `/infer/enhance` for access recognition:

1. Archive only the tracked `services/fcm-inference` source and copy it to a
   specifically named `/tmp` workspace over the deployment SSH key.
2. Tag the current `fcm/fcm-inference:local` image with its immutable image ID
   as a rollback image before rebuilding.
3. Build the CPU image in the staged workspace.
4. Recreate only `fcm-inference` from `/srv/fcm/current` with the existing
   `/opt/fcm/.env` and the explicit Compose project name:

```powershell
.\scripts\bob-vps-docker.ps1 -Action Command -Command `
  'cd /srv/fcm/current && docker compose -p fcm --env-file /opt/fcm/.env -f docker-compose.full.yml up -d --force-recreate --no-deps --no-build fcm-inference'
```

The explicit `-p fcm` is required because `/srv/fcm/current` is a symlink;
without it Compose derives a second project name and conflicts with the
existing `fcm-inference` container. After recreation, require Docker health,
public HTTPS `/health`, OpenAPI presence for every required route, and an
authenticated validation request before cleanup. Supabase Edge Functions use
the public HTTPS inference endpoint with `INFERENCE_SERVICE_URL` and
`INFERENCE_API_KEY` project secrets; never copy the Docker-only
`http://fcm-inference:3000` URL into cloud secrets.

## Tuning (control plane env, `/var/lib/bob/control-plane.env`)

- `BOB_BUILDER_ROUTE_AUTHOR` / `_REVIEW` / `_ANALYSIS` / `_LOCAL` /
  `_RESTRICTED` — comma-separated provider chains (`gpu_workstation`,
  `ollama`, `ollama_cloud`, `openai`). Unrestricted analysis, authoring
  and review default to `gpu_workstation,ollama_cloud,openai` (2026-10-21:
  the VPS CPU tier serves restricted-data runs and embeddings only).
  Restricted data never includes either external provider.
- `BOB_GPU_MODELS`, `BOB_OLLAMA_MODELS` — allowlists, best model first.
- `BOB_GPU_VRAM_MB` / `BOB_GPU_HEADROOM_MB` — default 8192 / 2048 MiB,
  based on the owner's RTX 5050 laptop diagnostic on 2026-10-18. The remaining
  6 GiB is a **weight-file budget**, not a measured free-memory promise.
  `/api/tags` must report the model size; unknown or larger sizes are excluded
  from author and independent-review selection. Context, display, other programs
  and Ollama runtime overhead can still require more memory; use `/api/ps` and
  `nvidia-smi` to verify actual residency. Do not force a larger model on a
  RAM-starved laptop. The former parameter-count minimum is removed.
- Gateway local requests keep models warm for five minutes and refuse overlapping
  local requests rather than load parallel models. This guard covers this gateway,
  not unrelated chat clients. The setup script's one-model/one-request settings
  take effect only when the owner runs it at a maintenance boundary.

### Failure truth, measurements and retention

The platform owner reviewing Builder runs sees separate categories for validation
rejection, connection failure, timeout, provider quota/rate limiting, capacity,
busy compute and interrupted runs. A response rejected by validation is not a
billing error. Missing usage is labelled "usage not recorded", not zero spend.
For new structured runs, usage survives validation rejection and records whether
output passed validation. Ollama's returned load time and generation rate are
reported when supplied; generation speed is not verified task completion.
No paid benchmark or production-job polling is needed to collect these metrics.

Main-health receipts are ANSI-normalised and compared with the repair's immutable
scope before model execution. A contradictory receipt pauses with an evidence
conflict; it does not widen unattended repair authority. Named, genuinely tracked
files are prioritised before the repository inventory is truncated. Schema-backed
Atlas RPC identifiers are valid inspection targets, not proof they were exercised.

The control plane checks terminal workspaces hourly while autopilot is enabled.
After seven days, it removes only clean registered worktrees for deployed, failed
or cancelled jobs, with no active model/worker run, pending approval or in-process
execution. Unpublished commits, untracked/ignored files, symlinks, unknown ages and
foreign repositories are preserved. Published commits require both the matching
receipt and remote-tracking ref. Removal is non-forced; branches, database receipts
and evidence artifacts remain. Retention actions and skip counts are audited.
This supplements nightly VPS cache/temp/backup hygiene; it does not uninstall
laptop models or delete personal files.
- `BOB_GPU_NUM_CTX` (default 32768), `BOB_OLLAMA_NUM_CTX` (default 16384) —
  a prompt that will not fit is sent onward instead of being truncated.

Chat lane (`/opt/fcm/.env`): `BOB_ROUTE_PLANNER`, `BOB_ROUTE_VERIFIER`,
`BOB_ROUTE_SUBAGENT`, `BOB_ROUTE_SYNTHESIS`, `GPU_WORKSTATION_MODEL`,
`GPU_WORKSTATION_PLAN_MODEL`.

## What the first live run showed (2026-09-26, laptop off)

Jobs 73560f1c and f6fbd0da, author on OpenAI (no GPU on the link), reviewer
chain `gpu_workstation → ollama → openai`:

- VPS `llama3.1:8b` cold-loaded for ~100 s and hit the adapter's 90 s budget
  once (`model gateway timed out`). Local providers now get
  `BOB_LOCAL_MODEL_TIMEOUT_MS` (default 420 s).
- On the next job it answered in 59 s with
  `{"verdict":"passed","summary":"", …}` — a hollow pass. The validator
  rejected it and the chain escalated to `gpt-5.6-sol`, which is the intended
  behaviour: a small model that rubber-stamps is "stuck", not "done". Expect
  the VPS CPU tier to be escalated past for real reviews until the laptop GPU
  (qwen2.5-coder:14b / qwen3-coder:30b) is on the link.

## The outsourced tier (OpenAI) — deterministic best-available

Because OpenAI is only reached when Bob is stuck, it should be the strongest
model the account has, at the highest effort the API allows:

- `BOB_OPENAI_MODELS` is an allowlist ordered **strongest first**. The gateway
  reads the account's `/v1/models` list (cached 10 min) and uses the first
  entry that exists, so a not-yet-released name at the front is harmless and
  a retired one is skipped. `BOB_BUILDER_MODEL` pins the author instead.
- The independent reviewer is the strongest available model that is **not**
  the author (`BOB_BUILDER_REVIEWER_MODEL` pins it).
- `BOB_BUILDER_REASONING_EFFORT=xhigh` — probed 2026-09-26: `xhigh` is the
  maximum for gpt-5.4 … gpt-6-*; `max` is rejected. `-pro` models are not chat
  models and cannot be used here.
- The chat planner's fallback (`OPENAI_PLAN_MODEL` in `/opt/fcm/.env`) is a
  separate choice: chat turns have a 90-second budget and, while the laptop is
  off, every turn lands there — keep it on a fast model (gpt-5.4) unless
  latency is acceptable.

`node scripts/bob-gpu-link/openai-probe.mjs <model...>` (with the key in the
environment, on the VPS) shows what each model accepts.
