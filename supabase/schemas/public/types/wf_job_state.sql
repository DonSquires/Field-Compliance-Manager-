create type "public"."wf_job_state" as enum (
  'draft',
  'verify_pending',
  'verified',
  'ratify_pending',
  'ratified',
  'running',
  'promoted',
  'failed'
);

grant usage on type "public"."wf_job_state" to "postgres";
