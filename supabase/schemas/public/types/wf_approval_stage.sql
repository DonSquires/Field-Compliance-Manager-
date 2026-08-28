create type "public"."wf_approval_stage" as enum (
  'verify',
  'ratify'
);

grant usage on type "public"."wf_approval_stage" to "postgres";
