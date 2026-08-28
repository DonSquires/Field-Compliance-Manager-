create type "public"."wf_approval_decision" as enum (
  'approved',
  'rejected'
);

grant usage on type "public"."wf_approval_decision" to "postgres";
