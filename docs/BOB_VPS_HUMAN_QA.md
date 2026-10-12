# Bob VPS Verification and Human QA

GitHub is the canonical source repository only. It runs no CI, agent, mirror, or
release workflow. Bob's control plane on the VPS owns routine verification and
the bounded repair loop.

## Main-Health Loop

On its existing autopilot tick, Bob resolves the current GitHub `main` SHA and,
once per SHA, runs an isolated `main-health` worker against a read-only checkout:

- Web production build.
- Full web Vitest unit and source-guard suite.
- Bounded Playwright smoke suite with offline fixtures.

The run receipt is persisted by SHA and exposed at the control plane `/health`
endpoint as `mainHealth.latest`. Timeouts, worker launch errors, or a moved
`main` SHA are retried/discarded; they do not classify the repository as red.

To activate this loop, the VPS control-plane environment must have the durable
direct-GitHub configuration `GITHUB_TOKEN`, `GITHUB_OWNER=DonSquires`,
`GITHUB_REPO=Field-Compliance-Manager-`, and `BOB_AUTOPILOT_AUTOMERGE=true`, in
addition to the existing Supabase, model gateway, and worker image settings.
The token belongs only in `/var/lib/bob/control-plane.env`; never put it in the
repository, a prompt, a test artifact, or a browser. `/health` must report
`builderGitHost: github`, `builderSourceConfigured: true`, and
`mainHealth.enabled: true` before the loop is considered active.

## Automatic Repair Boundary

When pinned checks fail with one to eight web source-guard test files, Bob opens
an idempotent, bot-attributed Builder job bound to the failed SHA and exact test
file allowlist. It does not assign a human requester. Bob diagnoses each guard
against the current app source and live schema, runs the checks again, and uses
independent code/security review. Only a patch touching those recorded test
files can pass the routine release gate and be merged by Bob through the direct
GitHub API at the verified head SHA. The workflow uses no GitHub Action.

Changes outside that allowlist, protected/evidential paths, failed independent
checks, a missing receipt, or changed GitHub head stop the automated merge.
The verified work remains a reviewable Builder result; no deployment is
inferred from a merge receipt.

## Human/Visual QA

The `human-qa` worker runs the fixture-backed Playwright walkthrough and stores
screenshots, traces, JSON reports, and HTML reports under its artifact directory.
The source bind mount is read-only, networking is disabled, and the worker is
bounded by timeout, memory, CPU, and PID limits. Live tests use only a dedicated
test identity and never receive service-role, GitHub, Vercel, or Supabase
management credentials.

RunPod is optional for model/inference or visual-analysis workloads. It is not
the verification controller and is not needed for the main-health loop.