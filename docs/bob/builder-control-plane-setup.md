# Builder Control-Plane Setup

Use this guide to connect the Supabase Builder Control Room to the dedicated Bob Builder host. This is separate from the general FCM API. Do not reuse `FCM_API_URL` or `FCM_API_TOKEN` for Builder execution.

## Required Values

The Builder relay needs two matching values in both environments:

- `BOB_CONTROL_PLANE_URL`: the HTTPS origin of the dedicated Builder host, for example `https://bob.example.com`.
- `BOB_ADMIN_TOKEN`: a random Builder-only bearer token.

The host also needs separate `BOB_RUNNER_TOKEN` and `BOB_MODEL_GATEWAY_TOKEN` values. Generate a distinct random value for each token.

## Provision the URL

1. Choose a dedicated hostname such as `bob.<your-domain>`.
2. Create a DNS `A` record for that hostname pointing at the Builder VPS.
3. Configure nginx from `deploy/bob-control-plane/nginx.conf.template` for that hostname and obtain a TLS certificate.
4. Confirm the public health endpoint responds:

```bash
curl -fsS https://bob.<your-domain>/health
```

Use the resulting HTTPS origin, without a trailing slash, as `BOB_CONTROL_PLANE_URL`.

## Generate Host Tokens

On a trusted host, generate separate values:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Place them in `/etc/bob-control-plane.env` on the Builder host:

```dotenv
BOB_ADMIN_TOKEN=<first generated value>
BOB_RUNNER_TOKEN=<second generated value>
BOB_MODEL_GATEWAY_TOKEN=<third generated value>
```

Keep `/etc/bob-control-plane.env` out of git and restrict it to the Builder service identity:

```bash
sudo chown root:bob-builder /etc/bob-control-plane.env
sudo chmod 640 /etc/bob-control-plane.env
sudo systemctl restart bob-control-plane
```

## Configure the Builder Host

The host environment must also include:

```dotenv
BOB_ALLOWED_REPOSITORIES=DonSquires/Field-Compliance-Manager-
BOB_ALLOWED_REFS=refs/heads/main
BOB_ASSESSMENT_ROOT=/opt/bob-control-plane/current
BOB_STATE_DIR=/var/lib/bob
BOB_WORKER_IMAGE=fcm/bob-worker:local
BOB_BUILDER_RUNNER_ID=bob-builder-host
SUPABASE_URL=<project URL>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
OLLAMA_URL=http://127.0.0.1:11434
BOB_OLLAMA_MODELS=qwen2.5:7b
```

A local Ollama endpoint requires no bearer token unless the host is configured to require one. For an authenticated private gateway, set `BOB_OLLAMA_AUTH_TOKEN` to its dedicated token.

## Verify Before Connecting Supabase

Run on the Builder host:

```bash
systemctl is-active bob-control-plane
curl -fsS http://127.0.0.1:8091/health
curl -fsS -H "Authorization: Bearer $BOB_ADMIN_TOKEN" http://127.0.0.1:8091/ready
docker image inspect "$BOB_WORKER_IMAGE" --format '{{.Id}}'
```

`/ready` must report all runtime checks as true before the host is connected to Supabase.

## Configure Supabase

Set only these two Edge Function secrets, using the same URL and admin token configured on the Builder host:

```bash
npx supabase secrets set \
  BOB_CONTROL_PLANE_URL=https://bob.<your-domain> \
  BOB_ADMIN_TOKEN='<Builder-only admin token>' \
  --project-ref dotczcyyzgabmtmnglqj
```

Do not print secret values in logs or commit them to repository files.

After the secrets are set, invoke `bob-builder-control-room` with `action: "advance"` for a Builder job. A successful relay means the job can progress from its passing platform assessment to the Product Analyst stage.
