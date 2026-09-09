# RunPod Serverless QA Worker

This is a separate, scale-to-zero RunPod Serverless endpoint for Bob browser QA. It sits beside the existing inference endpoint and does not share its image, handler, queue, credentials, or model workload.

## Use this when

- The full Playwright/human suite needs more CPU/RAM or parallel browser capacity than the VPS.
- Screenshot/visual analysis is added as an optional GPU stage.
- GitHub Actions is timing out on the broad matrix.

For ordinary fixture-backed Playwright, the VPS worker remains cheaper and is the default. RunPod is an elastic overflow/visual-analysis worker, not a permanent browser server.

## Job contract

The handler accepts only:

```json
{
  "source_archive_url": "https://signed-source-archive-url",
  "artifact_upload_url": "https://signed-artifact-upload-url",
  "profile": "ci-smoke | human | automation",
  "target_url": "https://...",
  "expected_sha": "...",
  "timeout_seconds": 900
}
```

URLs must be short-lived signed URLs issued by the Bob control plane. The worker does not accept arbitrary shell commands, repository credentials, service-role keys, Vercel tokens, or user passwords in the payload.

For `human`, the dedicated test identity is injected through the approved worker environment only; it is never returned in output. Live human runs require deployment freshness preflight before submission.

## Build and deploy

Build the image in a private registry, then create a distinct RunPod Serverless endpoint:

```bash
docker build -f runpod-qa-worker/Dockerfile -t <private-registry>/fcm-bob-qa:playwright-1.62.1 .
docker push <private-registry>/fcm-bob-qa:playwright-1.62.1
```

Configure the endpoint with:

- scale-to-zero when idle;
- a bounded max workers value;
- a request timeout no greater than the handler limit;
- private registry access;
- only the approved test identity environment values for the `human` profile;
- no inference model secrets unless a future visual-analysis stage explicitly needs them.

RunPod deployment itself requires approved RunPod credentials and is intentionally not performed by repository code. The existing VPS/Bob control plane should submit jobs and collect the signed artifact bundle, while RunPod remains optional overflow capacity.

## Separation guarantees

- Different image and endpoint from inference.
- No shared persistent volume.
- No access to the Docker socket.
- No arbitrary command input.
- Artifact output only through a signed upload URL.
- Result includes profile, expected SHA, target URL, status, exit code, and artifact digest.
