# Bob control-plane host deployment

The Builder control plane runs as a dedicated host service because it must start tightly constrained Docker workers. Do not mount the Docker socket into the public FCM API or a general-purpose web container.

## Host contract

1. Create the system user `bob-builder` with no interactive login and add it to the `docker` group.
2. Install the repository at `/opt/bob-control-plane/current`, owned by root and read-only to `bob-builder`.
3. Run `npm ci --omit=dev` in that checkout and build `fcm/bob-worker:local` from `Dockerfile.worker`.
4. Create `/var/lib/bob/tmp`, owned by `bob-builder:bob-builder`, with `/var/lib/bob` and its `tmp` child both mode `0700`. `TMPDIR` must remain under this host-visible path so the Docker daemon can bind worker artifacts while systemd `PrivateTmp` stays enabled.
5. Install `environment.example` as `/etc/bob-control-plane.env`, populate it through the host secret manager, and set ownership `root:bob-builder` with mode `0640`.
6. Install `bob-control-plane.service` under `/etc/systemd/system` with mode `0644`, reload systemd, enable, and start the service.
7. Render `nginx.conf.template` with a dedicated TLS hostname. The proxy exposes only public health and token-authenticated Builder execution routes.
8. Set Supabase secrets `BOB_CONTROL_PLANE_URL` to that HTTPS origin and `BOB_ADMIN_TOKEN` to the same dedicated control-plane token. Do not reuse `FCM_API_TOKEN`.

`BOB_ALLOWED_REPOSITORIES` and `BOB_ALLOWED_REFS` are the first repository policy gate. Gitea webhook intake currently accepts signed `push` events only, and both Gitea and manual job creation reject refs outside `BOB_ALLOWED_REFS`.

## Verification

Run these checks on the host without printing secret values:

```bash
systemctl is-active bob-control-plane
curl -fsS http://127.0.0.1:8091/health
curl -fsS -H "Authorization: Bearer $BOB_ADMIN_TOKEN" http://127.0.0.1:8091/ready
docker image inspect "$BOB_WORKER_IMAGE" --format '{{.Id}}'
```

`/ready` must report every check as `true` before configuring the Edge Function URL. A degraded public `/health` response is alive but not execution-ready.

The service may create isolated worker containers, but it has no production deployment route. Repository merge, production migration, and deployment remain human-controlled and disabled in the Builder runtime.

## Model runtime

Bob's Builder specialists route model work to Ollama by default so the app-builder path can run on the VPS without an external AI API. Set `OLLAMA_URL` to the local VPS Ollama endpoint first, then move the same variable to a private authenticated hPanel GPU gateway when that capacity is ready. Set `BOB_OLLAMA_AUTH_TOKEN` when that endpoint requires bearer authentication. The gateway may front Ollama or another OpenAI-compatible local model service, but it must not expose public unauthenticated inference.

Keep `OPENAI_API_KEY` empty unless an explicit external fallback is approved for a specific workload. Restricted data and repository snapshots must remain on the local/GPU path.

## Gitea deployment workflow

The manual workflow at `.gitea/workflows/bob-control-plane-host-deploy.yml` is the deployment path for VPS 1601189. It requires an explicit `deploy_ref`, runs the focused Bob control-plane tests, packages that exact checkout, uploads it to the VPS, installs it under `/opt/bob-control-plane/releases/<commit>`, repoints `/opt/bob-control-plane/current`, rebuilds the local worker image, restarts only `bob-control-plane`, and verifies `/health` plus authenticated `/ready`.

Required Gitea secrets are names only:

- `BOB_VPS_HOST`
- `BOB_VPS_USER`
- `BOB_VPS_SSH_KEY`
- `BOB_VPS_KNOWN_HOSTS`

The deploy user must be root or have passwordless sudo for the Bob-owned paths and `systemctl` commands. Do not store `/etc/bob-control-plane.env` values in Gitea; the workflow reads that file on the VPS without printing it.