# Supabase service identity decision

The live project was inspected on 2026-08-28 using read-only queries and a schema-only backup. `wf_user_roles` currently has no rows, four `grand_master` profiles exist, and the designated Bob profile exists. The lease migration is therefore not applied yet.

## Required identity split

Human control-plane requests must use a verified Supabase user identity. The control plane must preserve that user's ID as `created_by`, `decided_by`, and the audit actor. A static `BOB_ADMIN_TOKEN` is not sufficient for consequential workflow actions because it cannot provide per-user attribution or revocation.

Runner calls must use a separate service credential plus a job-scoped lease token. The service credential proves that the caller is the runner service; the lease token proves which job and run it may operate. A runner must never be allowed to choose an arbitrary human actor.

Bob's designated profile may be recorded as a system actor for autonomous assessment, classification, and proposal generation only. It must not be used to impersonate a human approver or to satisfy a human approval role.

## RPC requirements before live migration

1. Add explicit service-only RPC paths that check `auth.role() = 'service_role'` and require the lease token for runner operations.
2. Keep human approval RPCs on verified user JWTs and enforce `wf_user_roles` or the canonical application role source.
3. Require `actor_user_id` only on service operations that create a record on behalf of a known human, and validate that the ID belongs to an authorized, active profile. Prefer forwarding the human JWT where possible.
4. Remove `anon` execution from workflow RPCs and remove direct authenticated table updates that can bypass transition functions.
5. Test the service path, human path, missing identity, wrong lease, expired lease, and cross-job artifact cases against the live schema in a disposable test job.

Do not assign Bob `operator`, `verifier`, or `ratifier` merely to make the existing functions pass. That would make the system appear operational while weakening the accountability boundary.

## GitLab repository access

Bob's repository reader must use `GITLAB_READ_TOKEN`, scoped to the single approved GitLab project with read-only access. The optional `write_bob_chat` action must use a different `GITLAB_WRITE_TOKEN`; never fall back to the read token or a generic shared `GITLAB_TOKEN`. `GITLAB_PROJECT_ID` must be checked against the exact server-side `GITLAB_ALLOWED_PROJECTS` set. The Codespace should use its own separate read-only deploy token and must not receive either Supabase service credentials or Bob's write token.