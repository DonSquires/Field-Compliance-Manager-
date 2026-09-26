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
| Builder author (writes the code) | laptop GPU (`qwen2.5-coder:*`) | — | OpenAI (`gpt-6-sol`) |
| Builder independent reviewer | laptop GPU | — | OpenAI (`gpt-5.6-sol`) |
| Builder analyst / release notes | laptop GPU | — | OpenAI (`gpt-6-sol`) |
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

It makes the existing Ollama listen for the VPS (32k context, 2 h keep-alive),
pulls `qwen2.5:7b` and `qwen2.5-coder:7b` (~9 GB), opens port 11434 to the
Tailscale network only, and sets up **Bob's terminal** (below). Add
`-BiggerModels` for `qwen2.5-coder:14b` and `qwen3-coder:30b` if the GPU has
the room. Run it again any time; it only changes what is missing.

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

## Tuning (control plane env, `/var/lib/bob/control-plane.env`)

- `BOB_BUILDER_ROUTE_AUTHOR` / `_REVIEW` / `_ANALYSIS` / `_LOCAL` /
  `_RESTRICTED` — comma-separated provider chains (`gpu_workstation`,
  `ollama`, `openai`). Restricted data never includes `openai`.
- `BOB_GPU_MODELS`, `BOB_OLLAMA_MODELS` — allowlists, best model first.
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
