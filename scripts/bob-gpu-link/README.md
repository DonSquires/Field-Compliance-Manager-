# Bob's in-house compute: the GPU link

Bob works on his own compute first — your laptop's GPU when it is connected,
the VPS otherwise — and only outsources a step to OpenAI when he is stuck
(the local model is unreachable, the prompt does not fit its context window,
or its output fails verification). Every model run records which provider did
the work, so the cost split is auditable (`builder_model_runs.provider`).

## What runs where

| Role | First choice | Then | Last resort |
|---|---|---|---|
| Chat planner / drafting, synthesis | laptop GPU (`qwen2.5:7b`) | — | OpenAI (`gpt-5.4`) |
| Chat verifier (critic), research subagents | laptop GPU | — | OpenAI (`gpt-5.4-mini`) |
| Builder author (writes the code) | laptop GPU (`qwen2.5-coder:*`) | — | OpenAI (`gpt-5.4`) |
| Builder independent reviewer | laptop GPU | VPS Ollama (`llama3.1:8b`, CPU) | OpenAI (`gpt-5.4-mini`) |
| Builder analyst / release notes | laptop GPU | — | OpenAI |
| Embeddings, image/vision helpers | VPS Ollama | — | — |

The reviewer is always a different model identity from the author (checked in
the database when the review is recorded).

The VPS has no GPU. Its Ollama runs on CPU (~13 tokens/s on an 8B model), fine
for the Builder reviewer, which has minutes to answer, but too slow for a chat
turn — so the chat lane skips it unless you set `BOB_ROUTE_*` to include
`vps_ollama`.

## Connect the laptop (Windows)

Once, in PowerShell on the laptop, from a checkout of this repository:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-link.ps1
```

The first run prints a public key. On the VPS run
`bash scripts/bob-gpu-link/vps-setup.sh "<that key line>"` once, then run the
laptop command again. It starts Ollama with a 32k context window, pulls
`qwen2.5:7b` and `qwen2.5-coder:7b` (~9 GB), and holds a forwarding-only SSH
tunnel so the VPS sees your GPU as `host.docker.internal:11435`. Nothing on
the VPS can connect back into the laptop.

Register it to start at logon:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-link.ps1 -Install
```

### Bigger models (if the GPU has the room)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-link.ps1 -BiggerModels
```

pulls `qwen2.5-coder:14b` (needs ~10 GB VRAM at Q4) and `qwen3-coder:30b`
(a 30B mixture-of-experts with 3B active parameters — ~18 GB, runs split
across the GPU and 32 GB of system RAM at usable speed). Bob picks the best
installed model from the allowlist automatically (`BOB_GPU_MODELS` on the
control plane, best first). On an 8 GB card, stay with the 7B models.

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
