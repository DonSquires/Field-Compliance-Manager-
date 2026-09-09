# Bob FieldOps QA RunPod Deployment

A separate RunPod Serverless endpoint was created beside the existing inference endpoint.

| Role | Endpoint |
|---|---|
| Existing inference | `fieldops-ai-engine` (`katqqnmds1dphs`) |
| Bob FieldOps QA | `Bob FieldOps QA` (`3713mx7usg1jl6`) |

The QA endpoint uses the `ADA_24` pool, one maximum worker, and a zero-worker
idle policy. It is not used by inference and has no shared persistent volume.

## Health verification

```bash
curl -sS https://api.runpod.ai/v2/3713mx7usg1jl6/health \
  -H "Authorization: Bearer $RUNPOD_API"
```

The endpoint returned HTTP 200. At initial deployment, RunPod reported the QA
worker as `throttled`/queued while awaiting GPU capacity. This is expected for a
scale-to-zero endpoint and is distinct from an unhealthy inference endpoint.

## Job boundary

The endpoint accepts the signed job contract documented in
`runpod-qa-worker/README.md`. A request without `source_archive_url` and
`artifact_upload_url` is rejected by the handler before test execution. Real
jobs must be submitted by Bob's control plane with:

- a pinned source archive;
- a signed artifact upload URL;
- an allowlisted profile;
- an expected commit SHA;
- an explicit target URL for live human tests.

No user password, service-role key, Vercel token, or arbitrary shell command is
part of the RunPod request payload.

## Operations

The endpoint is intentionally separate from the existing inference endpoint.
RunPod may cold-start it when a QA job is submitted and returns to zero workers
when idle. Ordinary fixture-backed browser QA remains cheaper on the VPS; this
endpoint is for overflow capacity and future GPU-assisted visual analysis.
