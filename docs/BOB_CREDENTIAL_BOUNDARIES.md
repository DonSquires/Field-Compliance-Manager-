# Bob Credential Boundaries and Monitoring

Bob must use the narrowest credential for each operation. Credential values must never appear in prompts, browser code, logs, screenshots, issue bodies, test artifacts, or human-test reports.

The control plane loads `worker-executor.js` in its own process. A launcher
change therefore requires a control-plane redeploy as well as the worker-image
rebuild; an image rebuild alone does not update the running launcher.

## Private repository code and Vibe Builder

Vibe Builder runs against the private `DonSquires/Field-Compliance-Manager-`
repository. Its model context can contain owner messages, source code, diffs,
and tool output, so Vibe authoring is local-only: the GPU workstation and VPS
Ollama providers may be used; Ollama Cloud and OpenAI must not receive Vibe
session prompts or tool results. Do not add an external Vibe route without a
separate approved data-classification and egress control that proves what
content is safe to send. The Ollama Cloud key remains available only to the
other unrestricted workloads already governed by the model adapter; its
presence does not authorize Vibe source-code egress.

## Visual baseline generation

`generate_visual_baselines` is shared by the frontend agentic engineer
(including self-heal/autopilot) and Vibe's fullstack tools. It accepts at most
six exact standard Playwright Linux PNG paths plus the intentional-change
rationale, never raw image bytes or shell commands. Only this tool grants PNG
provenance for a turn. After a checkpoint resume, call it again to reverify the
restored images; matching images are a valid no-change verification.

The `visual-baseline` worker always uses `--network=none`, a read-only source
mount and disposable writable work area, with no credentials, Docker socket or
live test identities. Tests use the existing offline fixtures. It generates
requested screenshots, runs the same specs with screenshot comparison enabled,
then repeats rendering, restores the exact candidate bytes and compares against
them using the existing spec assertions/tolerances. Candidate and rendered
hashes are distinct provenance: two pixels of broken-image-icon raster drift
in a 1.44-million-pixel fixture are not grounds to rewrite the candidate or
increase tolerances. It rejects
unrequested screenshot changes and functional failures, retains private
`before/`, `after/`, `baseline.json` and `baseline.patch` under the workspace
parent's `.visual-baseline-runs/`, and binds output to the source commit and
current diff. Workspace drift refuses application, not a best-effort apply.

Only regular PNG additions/replacements in standard `*.spec.ts-snapshots/`
paths can travel in git binary patches. General binary editing remains refused.
The independent frontend verifier rerenders these PNGs, compares against the
restored candidate, preserves its exact bytes and then runs the normal
verification commands; its existing `build_logs`
artifact carries the hash/command receipt. The PR's image diff presents old and
new images from Git history. Fixture renders do not prove live tenant behavior.
Existing human release holds still apply, and visual-baseline PRs never receive
the unattended-merge marker. Vibe still publishes only when the owner ships.

## No arbitrary-user login

Bob must not retrieve, reveal, or use another person's password, recovery link,
refresh token, access token, cookie, MFA factor, or active browser session. A
service-role database key does not grant permission to impersonate a user. User
credentials are authentication secrets, not test fixtures.

To reproduce a role-specific problem, use one of these approved paths instead:

1. A dedicated, non-production test identity for the required role and tenant,
	with a secret supplied directly to the test runner and never returned to Bob.
2. A governed session broker that mints a short-lived, audience-limited test
	session for an approved test identity, records actor, target role, tenant,
	reason, expiry, and correlation ID, and prevents production identities.
3. A human-operated reproduction where the affected user signs in themselves
	and shares only redacted observations, request IDs, and screenshots.

Any session broker must fail closed, require explicit approval, prohibit
cross-tenant targeting, disable destructive actions by default, and emit an
audit event. It must never accept a password or token supplied in a Bob prompt.

## Credential map

| Credential | Where it may be used | Purpose | Must not be used for |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` (Supabase Management token; the Codespaces secret of the same name is the valid one, `FIELD_COMPLIANCE_CODESPACE` was rejected with 401 on 2026-10-21) | Codespaces terminal; the VPS release lane (`/var/lib/bob/release-lane.env`) and control plane (`/var/lib/bob/control-plane.env`, with `SUPABASE_PROJECT_REF`) | Applying merged migrations with a ledger row, deploying changed edge functions, regenerating `schema.sql` and `src/types/database.ts`, explicitly approved bounded seed SQL | Edge Function runtime, browser, Bob prompt, ordinary live data API header |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Functions/server-side diagnostics and explicitly approved Codespaces read checks | Bypassed-RLS server-side reads, governed service operations, Atlas checks | Browser/frontend, external web research, issue text, screenshots |
| `SUPABASE_ANON_KEY` | Supabase client/Edge Function caller client | Establish caller-authenticated Supabase context | Privileged database access |
| Caller `Authorization: Bearer <user JWT>` | Request forwarding from an authenticated Edge Function | Preserve the user's identity, role, tenant, and RLS context | Replacing service-role authorization for approved server operations |
| `GITLAB_TOKEN` / `GITLAB_READ_TOKEN` | Bob repository-search/read-issues functions | Read the allowlisted GitLab repository and issues | Supabase, Vercel, arbitrary repositories, write operations |
| `GITEA_TOKEN` | `bob-gitea-maintainer` server-side function | Governed issue/PR/file operations on the allowlisted Gitea repository | Browser, Supabase, arbitrary repositories |
| `BOB_GITHUB_ACCESS_TOKEN` (owner ruling 2026-10-21: Bob's single GitHub API credential) | VPS control plane (`/var/lib/bob/control-plane.env`) and Codespaces | Every Bob GitHub API action: branches, pull requests, verified merges, issues, reviews, main-health status | Browser, Bob prompts, logs, issue text; a second GitHub token must not be added beside it (the stale `GITHUB_TOKEN` was removed) |
| Bob GitHub deploy key (`BOB_GITHUB_SSH_KEY_FILE` / `BOB_FCM_MAIN`) | Control plane and release lane, git transport only | Fetch `main`, push `bob/job-*` and `bob/vibe-*` branches | API calls, any other repository |
| Role test identities (`GRANDMASTER_`, `MASTER_`, `OFFICER_`, `NMDHB_TEST_EMAIL`/`_PASSWORD`) | Dr Bob human-test workers and live e2e specs | Dedicated test accounts for role-specific glass checks | Real users' sessions; never printed or stored in receipts |
| `VERCEL_TOKEN` | Vercel viewer function/server-side deployment tooling | Inspect approved Vercel deployment state | Supabase, database migrations, browser |
| VPS/PTT/control-plane tokens | Their specific server-side viewer or control-plane function | Inspect or operate the named approved service | General repository, database, or browser access |
| `OLLAMA_API_TOKEN` (Ollama Cloud key; also accepted as `OLLAMA_API_KEY`) | VPS control-plane model gateway only (`/var/lib/bob/control-plane.env`), sent as a Bearer header to `https://ollama.com` | Bob Builder's subscription model tier for unrestricted work, after the laptop GPU and VPS Ollama and before paid OpenAI | Restricted/local-only work (the router strips it), local Ollama hosts, browser, Bob prompts, logs, health output, issue text |
| Bob laptop SSH key (`/var/lib/bob/laptop/id_ed25519`, VPS only) | `bob-laptop-shell.js` in the control plane, over Tailscale, to the owner's laptop only, while the owner's `laptop-tailscale.ps1 -Allow` switch is on | Owner-confirmed PowerShell commands (read files, check the GPU link, setup the owner asked for) | Any other host, unattended or unconfirmed commands, destructive/privilege/credential/firewall changes (refused by the deny list), copying the key anywhere |
| Host docker socket → VPS firewall (owner ruling 2026-10-21: Bob changes the firewall directly) | `bob-firewall.js` in the control plane, via `/api/bob/firewall/*` (control-room actions `firewall_status`/`firewall_change`, grand master only) and Vibe Builder's `firewall_status`/`firewall_change` tools | Structured allow/deny rules in the Bob-owned `BOB-INPUT` (from `INPUT`) and `BOB-WORKER-EGRESS` (from `DOCKER-USER`, worker subnet `172.31.250.0/24`) chains; persisted in `/var/lib/bob/firewall/rules.json` and re-applied at control-plane start; every change audited (`firewall.change`) | Free-form shell, other chains, UFW/Docker/Tailscale rules, denies that lock out SSH (22), the public app (80/443) or Tailscale (udp 41641) — refused; laptop firewall (still owner-only) |

### Worker network (owner ruling 2026-10-21)

Owner extension, 2026-10-21: self-heal and autopilot engineers also receive the
structured firewall tools. The control plane records the acting lane, job ID,
purpose and change result; worker containers never receive the Docker socket
or host-management credentials.

Tailscale OAuth credentials (`TAILSCALE_OAUTH_CLIENT_ID` and
`TAILSCALE_OAUTH_CLIENT_SECRET`) live in Codespaces secrets and the VPS
control-plane environment, never in model prompts, browser bundles or workers.
The required scopes are policy-file read/write and devices-core read.
`TAILSCALE_TAILNET` selects the tailnet; `TAILSCALE_OWNER_LOGIN` is required for
policy writes. These credentials are not needed by Supabase Edge Functions:
owner-only control-room actions relay to the authenticated control plane.

Vibe, self-heal and autopilot use `tailnet_status` and `tailnet_acl` when the
credential is configured. Reads return canonical JSON and an ETag. Writes
require strict JSON, the matching ETag, successful Tailscale validation, an
explicit unrestricted network grant to the configured owner, and unchanged
Tailscale SSH rules. The previous policy is saved privately under
`/var/lib/bob/tailscale/acl-history` before the conditional write. Every live
policy change is audited separately from repository changes; a git undo does
not restore a tailnet policy.

Verification, build, test and main-health workers run on Bob's own `bob-workers` Docker bridge
network (created on demand, subnet `172.31.250.0/24`), which reaches the internet and the Tailscale
tailnet through the VPS. Workers still receive no credentials (only the named human-test variables
for the human-QA profiles), run read-only with all capabilities dropped and without the Docker socket,
and their outbound traffic is governed by the `BOB-WORKER-EGRESS` chain. `BOB_WORKER_NETWORK=none`
in `control-plane.env` restores fully offline workers; `host` is refused.

Main-health also mounts root runtime dependencies into a disposable
`/workspace/node_modules` so both CommonJS and ESM imports work without an
install. Its `/tmp` permits execution because root tests create executable
git/npm fixtures there; other profiles retain their existing tmpfs policy.
Before Docker starts, the control plane creates the empty dependency and
`.bob` mountpoint directories in fresh detached checkouts; execution still
uses a read-only source bind and disposable tmpfs contents.
Git-based inventory tests consume a tracked-file manifest produced from that
checkout's pinned Git tree before launch, rather than mounting host Git
metadata or credentials into the worker.
Root node:test, lint, build, Vitest and browser-smoke steps each emit a
START/PASS/FAIL marker and all run even if an earlier check fails. Root TAP
failure paths remain repository-root paths through repair intake; none are
rewritten as web paths. Root/backend and screenshot changes still require the
existing human release approval.

## Monitoring record

Every Bob diagnostic or human-test run should record only:

- Credential class used, never the value.
- Environment and target project/repository/deployment.
- Caller role and organization scope where applicable.
- Read/write mode.
- Tool/function name.
- Query or action purpose.
- Result status and redacted error code.
- Timestamp and request/correlation ID.

Example:

```text
credential_class=FIELD_COMPLIANCE_CODESPACE
operation=supabase_migration_dry_run
project=dotczcyyzgabmtmnglqj
mode=read-only
result=blocked_duplicate_migration_version
secret_value=never_recorded
```

One-off management scripts must accept the neutral variable name
`SUPABASE_ACCESS_TOKEN`; the Codespaces secret of that name is valid and used directly:

```bash
node scripts/seed-legacy-noise-dispatch.js   # SUPABASE_ACCESS_TOKEN is already set in Codespaces
```

The script must never print the value or persist it in an artifact.

## Required checks before a Bob run

1. Confirm the target URL/project/repository explicitly.
2. Confirm the credential class matches the operation.
3. Confirm the caller role and tenant scope for live record reads.
4. Use read-only mode first; require an explicit approval for writes, migrations, issue creation, or deployment.
5. Redact responses before attaching them to Bob artifacts or issues.
6. After the run, verify no secret-shaped value entered logs, browser storage, screenshots, traces, or reports.

For role testing, also record `test_identity_class` (for example
`admin_fixture`, `officer_fixture`, or `human_operator`) and never record the
identity's password or token.

## Specific live-test rule

The Playwright human test uses user credentials only to authenticate the deployed app. It must not receive `SUPABASE_SERVICE_ROLE_KEY`, `FIELD_COMPLIANCE_CODESPACE`, Git provider tokens, or Vercel tokens through browser context or page scripts. Direct Supabase checks belong in a separate server-side diagnostic step and must be redacted.

## Incident response

If a token appears in output or an incorrect credential is used:

1. Stop the run and invalidate/rotate the exposed credential.
2. Preserve only the redacted request ID, tool, target, and timestamp.
3. Review audit logs for the affected function/provider.
4. Re-run using the correct credential class in read-only mode.
5. Create a security issue only with redacted evidence.
