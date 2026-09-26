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
