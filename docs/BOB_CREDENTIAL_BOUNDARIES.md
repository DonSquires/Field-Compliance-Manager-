# Bob Credential Boundaries and Monitoring

Bob must use the narrowest credential for each operation. Credential values must never appear in prompts, browser code, logs, screenshots, issue bodies, test artifacts, or human-test reports.

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
| `FIELD_COMPLIANCE_CODESPACE` / `SUPABASE_ACCESS_TOKEN` | Codespaces terminal, explicitly approved Supabase CLI or one-off Management API seed command | Migration status, migration repair, database push, explicitly approved bounded seed SQL | Edge Function runtime, browser, Bob prompt, ordinary live data API header |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Functions/server-side diagnostics and explicitly approved Codespaces read checks | Bypassed-RLS server-side reads, governed service operations, Atlas checks | Browser/frontend, external web research, issue text, screenshots |
| `SUPABASE_ANON_KEY` | Supabase client/Edge Function caller client | Establish caller-authenticated Supabase context | Privileged database access |
| Caller `Authorization: Bearer <user JWT>` | Request forwarding from an authenticated Edge Function | Preserve the user's identity, role, tenant, and RLS context | Replacing service-role authorization for approved server operations |
| `GITLAB_TOKEN` / `GITLAB_READ_TOKEN` | Bob repository-search/read-issues functions | Read the allowlisted GitLab repository and issues | Supabase, Vercel, arbitrary repositories, write operations |
| `GITEA_TOKEN` | `bob-gitea-maintainer` server-side function | Governed issue/PR/file operations on the allowlisted Gitea repository | Browser, Supabase, arbitrary repositories |
| `VERCEL_TOKEN` | Vercel viewer function/server-side deployment tooling | Inspect approved Vercel deployment state | Supabase, database migrations, browser |
| VPS/PTT/control-plane tokens | Their specific server-side viewer or control-plane function | Inspect or operate the named approved service | General repository, database, or browser access |
| `OLLAMA_API_TOKEN` (Ollama Cloud key; also accepted as `OLLAMA_API_KEY`) | VPS control-plane model gateway only (`/var/lib/bob/control-plane.env`), sent as a Bearer header to `https://ollama.com` | Bob Builder's subscription model tier for unrestricted work, after the laptop GPU and VPS Ollama and before paid OpenAI | Restricted/local-only work (the router strips it), local Ollama hosts, browser, Bob prompts, logs, health output, issue text |
| Bob laptop SSH key (`/var/lib/bob/laptop/id_ed25519`, VPS only) | `bob-laptop-shell.js` in the control plane, over Tailscale, to the owner's laptop only, while the owner's `laptop-tailscale.ps1 -Allow` switch is on | Owner-confirmed PowerShell commands (read files, check the GPU link, setup the owner asked for) | Any other host, unattended or unconfirmed commands, destructive/privilege/credential/firewall changes (refused by the deny list), copying the key anywhere |

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
`SUPABASE_ACCESS_TOKEN`; callers may map the Codespaces secret at invocation:

```bash
SUPABASE_ACCESS_TOKEN="$FIELD_COMPLIANCE_CODESPACE" node scripts/seed-legacy-noise-dispatch.js
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
