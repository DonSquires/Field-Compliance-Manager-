# Workflow lease rollout

This migration must be applied against the existing live Supabase schema. The repository contains a schema dump, not a complete replayable migration baseline, so do not use a local database reset as a substitute for live-schema verification.

## Required preflight

1. Confirm the target project and linked database are the intended environment.
2. Take a database backup or confirm the provider's point-in-time recovery window.
3. Inspect the live definitions of `public.wf_jobs`, `public.wf_runs`, `public.wf_artifacts`, `public.wf_pickup_run`, and `public.wf_return_artifact`.
4. Check for existing duplicate `picked_up` runs per job and existing calls to the old artifact RPC signature.
5. Confirm the live PostgreSQL major version and that `pgcrypto` is available for `gen_random_bytes`.
6. Confirm the service-to-service identity design. The migration still requires `auth.uid()`; it does not solve the existing service-role versus human-identity problem.

## Apply order

Apply `supabase/migrations/20260828000000_workflow_run_leases.sql` through the approved Supabase migration process. Do not paste it into an ad-hoc production SQL session without recording the migration version and operator identity.

## Post-apply checks

Verify that:

- `wf_runs` contains the lease columns;
- `wf_runs_one_active_lease_per_job` exists;
- `wf_pickup_run` locks the job and rejects a second active lease;
- `wf_heartbeat_run` rejects an expired or incorrect token;
- `wf_return_artifact` rejects a mismatched job, run, or lease token;
- anonymous execution is revoked for the new heartbeat and artifact signatures;
- an authenticated test user can complete one disposable pickup, heartbeat, and artifact return;
- the test artifact's object path, checksum, and size are verified independently against storage.

Record the live schema version, test job ID, run ID, and verification result as a release artifact. Never use a real customer or production artifact for this test.

## Rollback posture

Do not drop lease columns or replace the secured functions with the old versions as an emergency rollback. Disable new worker rollout, preserve the migration, and investigate using the backup and audit trail. Column removal can destroy lease evidence and is not an additive rollback.