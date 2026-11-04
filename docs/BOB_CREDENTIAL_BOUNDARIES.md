# Bob Credential Boundaries and Monitoring

Bob must use the narrowest credential for each operation. Credential values must never appear in prompts, browser code, logs, screenshots, issue bodies, test artifacts, or human-test reports.

## Officer shift recovery (2026-11-06)

The overdue-shift path uses the signed-in officer's existing authorization.
`get_officer_recovery_readiness` delegates to the existing shift-readiness
authorization and returns an explicit count-only projection: stop names,
unrestricted service labels, free-text blockers and future unrecognised fields
do not reach the browser. The overdue schedule query also omits those labels
and briefing notes.
There is no service-role credential or fallback to the raw readiness RPC. The
migration must be applied through the governed production lane before this
path can work; a missing projection fails closed and directs the officer to
operations.

This projection does not close the existing raw RPC, table, patrol, dispatch
or safety-briefing paths, and it is not an Oracle review of their contents.
Those separately authorised surfaces must be protected before claiming a
complete officer-briefing privacy boundary.

## GitHub support automation (owner decision, 2026-10-24)

GitHub repository secrets now include `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Only
their names were inspected, not their values. Their presence is not authority
to make them available to PR code. No additional credentials were copied.

The owner initially chose PR verification, then lifted the GitHub-specific
restrictions and delegated supporting workflow selection while retaining
Vibe Builder and Bob Builder as the primary builders. There is no workflow-name
allowlist or blanket prohibition on GitHub support jobs. The selected topology
uses GitHub for CI, review and retained evidence, with the VPS still the sole
production migration writer rather than adding a second release writer.

`.github/workflows/verify-pr.yml` runs on PRs, pushes to `main` and manual
dispatch. It uses no repository secrets,
read-only contents permission, and checkout without persisted credentials.
Independent jobs check the runtime/migration inventory, web types/build/unit
tests and offline fixture browser workflows. Artifacts contain fixture browser
evidence only. Failures remain red; existing Overview guard/snapshot failures
are not suppressed.

This workflow does not apply migrations, deploy functions, refresh live Atlas,
write embeddings or send email. Adding secrets does not implement those jobs.
Production migrations remain single-writer in the governed VPS release lane.
Before implementing any credentialed support job, define approved environments,
reviewer/branch protection, exact caller/data scope, idempotency and audit
receipts; do not give untrusted PRs or fork code production secrets.
The first such job is `.github/workflows/atlas-refresh.yml`: it writes only
Atlas tables, runs only for the verified current `main` head, and reads its
service-role key from the `atlas-refresh` environment, restricted to `main`.
Existing GitHub Production environments had no approval protection when
inspected. `BOB_GITHUB_ACCESS_TOKEN` need not be added to verification: the
job-scoped read-only GitHub token is sufficient. A future project-reference
consumer must explicitly map `SUPABASE_PROJECT_ID` to its expected
`SUPABASE_PROJECT_REF` setting rather than assuming they are already wired.

The control plane loads `worker-executor.js` in its own process. A launcher
change therefore requires a control-plane redeploy as well as the worker-image
rebuild; an image rebuild alone does not update the running launcher.

## Private repository code and Vibe Builder

### Officer operational briefings (2026-11-05)

`officer-shift-briefing` verifies the active user and uses the caller JWT for
the exact own static assignment and safety RPCs before service-role site,
work-unit and primary/emergency contact reads. The browser never receives a
service-role or control-plane credential. Operational contacts are authorised
structured records, not names inferred from narrative.

The edge calls `/api/bob/officer/privacy` with the existing server-only
control-plane credential class. That route constructs a fixed
`officer_privacy` request on the qualified private `gpu_workstation`, with
private-host validation and no redirects for sensitive POSTs. There is no
automatic VPS or cloud fallback: the VPS's synthetic qualification timed out
at the request budget and is not approved to disclose briefings. An unavailable
GPU leaves narrative withheld. Oracle findings contain exact spans;
Conductor performs disclosure and binds its receipt to the source SHA256.
Unknown source fields and source-document links are excluded. Unavailable,
incomplete or source-mismatched findings withhold narrative/H&S and prevent
the officer UI from proceeding through start.

Requests/responses are not cached; failures log only the credential class
boundary/outcome, never source text, model output or tokens. This path does
not upload or approve restricted assessments, grant clinical-history access,
verify a site boundary, or authorise live attendance. Validate a release with
synthetic material before sending any approved private source.

### Builder Chat cloud PM/QA (owner decision, 2026-10-25)

New PM turns use purpose-assigned Ollama Cloud models directly, without private
inference attempts. The owner selected human-approved non-sensitive summaries,
not raw private evidence. The server must bind purpose and summary to the same
message's approval and retry identity. Neither earlier conversation nor selected
job/page context is implicitly transferred. The current slice accepts a summary
pasted by the reviewer after redaction. Future governed private collection may
prepare a candidate for review, but cannot automatically approve its external
transfer or introduce a private inference ladder for Chat. Sensitive source,
credentials and tenant/HR/legal data
remain excluded. Exact text matching proves only what a reviewed summary said,
not that its underlying assertions were independently observed.

Capability metadata must match the selected purpose's inputs. Unavailable,
invalid or non-vision models fail explicitly; no automatic model ladder or
private fallback. Independent QA is a deliberate purpose, not an automatic
second model on every PM answer. Existing explicit public-research mode remains
isolated. Model receipts disclose purpose, model and the actual transfer shape.

Bob's own diary is not tenant operational memory. The cloud PM may choose
`write_self_memory` to append a bounded non-sensitive reflection or Builder
note to existing `bob_self_memory`, via a service-only, retry-safe RPC bound to
the originating owner PM turn. No memory approval or growth score is created.
The model receives the saved ID, not private earlier entries. Optional recall
uses the existing authenticated `bob-self-memory-read` endpoint to preview
entries privately in the owner UI. Selecting an excerpt copies it to the
reviewed summary and invalidates packet approval; nothing is automatically
sent to cloud, promoted to knowledge or copied from tenant conversation.

PM specification-revision follow-up (2026-10-26): the cloud model supplies
only a job UUID from the approved packet and bounded feedback. A server-side
read verifies the accepted handoff in the same thread and pins its pending
specification approval/target; no private specification or job history is
returned to cloud. The original approved human message is attached verbatim.
An authenticated owner confirms the card via
`builder_chat_request_spec_revision`; service-role and anonymous execution
are not granted. That transaction records a replay-safe audit receipt,
supersedes the reviewed artifact, cancels the old pending approval and
returns the same idle job to analysis. It cannot approve implementation,
change the immutable task/target, reset attempt counts or create a new job.

Code-review correction extension (owner choice, 2026-10-26): the same approved
packet boundary applies to `request_builder_code_changes`. Server-only
same-thread pending approval lookup never returns private job evidence to
cloud. `builder_chat_request_code_changes` is authenticated-owner execution
only, with existing organization/reviewer checks. Confirmation cancels the
old human review and records the original human message plus PM feedback
against the existing job. Retained superseded patches may be read only as
explicitly bound, checksum-verified lane seeds, never as fresh review evidence.
No new credential, impersonation, automatic history transfer, merge or release
authority is introduced.

Failed implementation-correction recovery (owner choice, 2026-10-26) uses the
same approved packet and authenticated-owner confirmation boundary. The
service-side preparation reads only the linked failed job/version and failed
step metadata, never returning private diagnostics to cloud.
`builder_chat_recover_implementation` rechecks organization/reviewer authority,
same-thread completed PM consent, idle unpublished correction state and an
author failure without a patch before downstream checks. It records a
replay-safe receipt, preserves attempts and seeds, and invalidates the saved
author checkpoint. It cannot recover worker/test/security failures, change
target/specification, approve, merge or deploy.

### Builder chat public research (owner decision, 2026-10-25)

Builder chat's explicit public-research mode uses only server-side Ollama Cloud
credentials and the fixed official API origin. It requires both the configured
cloud flag and immutable per-message owner approval. The private chat/planning
lane does not escalate repository/history packets to cloud. Approval is a human
non-sensitive-content attestation, not an automated classification guarantee.
Never attach secrets, tenant records, private source or confidential documents.

The research RPC binds the question, URLs and file manifest to the authenticated
thread owner and request ID. Changed input cannot reuse that ID to upgrade
consent. Attachments are private `bob-uploads` objects under
`desktop/{user_id}/builder-chat/{thread_id}/{attachment_id}-{safe_name}`;
the RPC checks storage ownership and the worker verifies scope, byte size and
SHA-256. Images require explicit raw-image approval and live vision capability.
Documents send up to 12,000 extracted characters, never the raw original through
the current adapter. XLSX extraction uses the existing extractor's selected
largest populated sheet, not every sheet. Empty/scanned PDFs fail pending OCR.
Question/files do not include prior chat or repository tools.

Web search and fetch use the same fixed Ollama origin, not arbitrary server-side
URL requests. Source URLs exclude credentials, query strings, fragments,
custom ports, IP literals and local/reserved names. Pages/files are untrusted
evidence. Receipts distinguish checked publisher/quote provenance from semantic
verification; unmatched quotes fail, under-corroborated claims remain unverified.
Neither approval nor research grants deployment or job-creation authority.

Vibe Builder runs against the private `DonSquires/Field-Compliance-Manager-`
repository. Its model context can contain owner messages, source code, diffs,
and tool output, so Vibe authoring is private-first: the GPU workstation and VPS
Ollama providers are always tried first. Owner ruling 2026-10-22 ("ollama web
is an option and local for smaller jobs"; "you can use alternative methods and
models as needed") approves Ollama Cloud as the only external Vibe escalation,
under these egress controls:

- It is off unless the control plane sets `BOB_VIBE_ALLOW_OLLAMA_CLOUD=true`.
- It is reached only after the private candidates: when they are unavailable,
  or as the single repeated-tool-call recovery.
- Attachment-bearing messages are local-only by default. Under the owner's
  2026-10-25 opt-in ruling, the owner may attest, for that message only, that
  the selected files contain no personal, confidential, restricted, credential
  or proprietary information. Only then may their locally extracted text or
  local image descriptions accompany an otherwise permitted Ollama Cloud
  escalation. Raw attachment bytes never leave private compute.
- The attestation is a human classification decision, not an automated
  sensitivity certification. Sensitive or uncertain content must stay local;
  do not opt in until it has been reviewed/redacted. The checkbox defaults off,
  resets when the attachment selection changes and after sending, and never
  authorizes a different message or a different provider.
- The owner-only `builder_vibe_send_with_attachments_opt_in` RPC records the
  choice, actor, timestamp, policy version and attachment IDs on the queued
  message. A request-id replay cannot change consent. The worker records the
  attachment-context IDs and `raw_attachments_sent: false` with cloud use.
- Earlier attachment context is never authorized by the current opt-in.
  When any earlier owner message in the session carried attachments (checked
  session-wide, not just within the recent history window), earlier
  conversation, session titles, commit subjects, changed paths, execution logs,
  pre-cloud model/tool exchanges and file-search terms drawn from earlier
  messages are withheld from the automatically assembled cloud packet to
  avoid forwarding paraphrased private analysis. A failed check recorded
  before the message still blocks handoff, but the cloud model receives only
  the verification type, not its arguments, paths or earlier output. Automatic
  recovery also withholds earlier tool output and the branch diff; cloud models
  cannot reuse a browser report produced privately or in an earlier turn.
  Private models retain that history. Freshly requested tool results reflect
  the current workspace and are not provenance-classified; use a private model
  if workspace material may contain sensitive attachment-derived content.
  Consent does not authorize promoting any source into business records or
  changing record access.
- Ollama Cloud receives structured JSON requests, never native tool
  definitions, and each escalation posts a session status with
  `external_egress: true`.
- OpenAI and every other hosted provider remain forbidden for Vibe prompts and
  tool results. The Ollama Cloud key's presence alone does not authorize egress;
  the flag and these controls do.

Vibe file attachments are stored in the private `bob-uploads` bucket under the
owner's `desktop/{user_id}/vibe/{session_id}/` path and are registered against
that exact session. The worker reads only the attachment IDs on the owner's
message. Supported inputs are JPEG/PNG/WebP screenshots (10 MB each) and
PDF/DOCX/TXT/CSV/XLSX documents (20 MB each; five files per message). Documents
use the existing `bob-extract-document` text extractor; images use the
configured local Ollama vision endpoint (`OLLAMA_VISION_URL`, otherwise the
private `OLLAMA_BASE_URL`) and `OLLAMA_VISION_MODEL` (default `moondream`).
The worker verifies the endpoint resolves to private addresses and confirms the
model is installed before sending image bytes. It never falls back to a hosted
model. Extracted text and visual descriptions are scoped to the Vibe session,
treated as untrusted advisory context, and are not registered or promoted as
business records. If the local vision endpoint/model is unavailable, the image
turn fails visibly rather than claiming Bob inspected the screenshot.

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
| Role test identities (`GRANDMASTER_`, `MASTER_`, `OFFICER_`, `NMDHB_TEST_EMAIL`/`_PASSWORD`) | Dr Bob human-test workers and live e2e specs; `GRANDMASTER_TEST_*` also powers Bob's automatic post-production Dr Bob suite and, in the control plane only, files that suite's redacted live findings through the user-JWT `bob-triage-report` path, then signs out (owner ruling 2026-10-27) | Dedicated test accounts for role-specific glass checks, including service-owned read-only production verification without a person requesting each run; reporting Bob's own observed runtime friction | Real users' sessions; never printed or stored in receipts or `triage_intake`; never used for business-record writes, approvals or impersonation |
| `VERCEL_TOKEN` | Vercel viewer function/server-side deployment tooling; the control plane's production-deployment resolver, which checks the serving SHA before and after every live Dr Bob walk | Inspect approved Vercel deployment state and the SHA serving the production alias | Supabase, database migrations, browser contexts, Dr Bob worker containers (they receive only the verified SHA), unmerged branch commits, Dr Bob receipts |
| VPS/PTT/control-plane tokens | Their specific server-side viewer or control-plane function | Inspect or operate the named approved service | General repository, database, or browser access |
| `OLLAMA_API_TOKEN` (Ollama Cloud key; also accepted as `OLLAMA_API_KEY`) | VPS control-plane model gateway only (`/var/lib/bob/control-plane.env`), sent as a Bearer header to `https://ollama.com` | Bob Builder's subscription model tier for unrestricted work, after the laptop GPU and VPS Ollama and before paid OpenAI | Restricted/local-only work (the router strips it), local Ollama hosts, browser, Bob prompts, logs, health output, issue text |
| `BASE44_RAMS_READ_TOKEN` (Base44 personal access token "FCM read-only sync (RAMS OFO)", read-only, scoped to the RAMS (OFO) app; owner-issued 2026-11-03) | VPS sync timer (`/var/lib/bob/base44-rams-read-token`, root `600`); repository Codespaces secret of the same name; laptop fallback file `%LOCALAPPDATA%\FCM\base44\rams-read-token` | GET-only Base44 reads by `scripts/sync-base44-rams.mjs` (see `deploy/base44-rams/README.md`) | Any Base44 write, other Base44 apps, browser, Bob prompts, logs, reports, issue text |
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
