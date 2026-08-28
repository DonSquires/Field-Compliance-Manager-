create type "public"."wf_run_status" as enum (
  'queued',
  'picked_up',
  'succeeded',
  'failed'
);

grant usage on type "public"."wf_run_status" to "postgres";
