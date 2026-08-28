create type "public"."wf_app_role" as enum (
  'requester',
  'verifier',
  'ratifier',
  'operator',
  'runner'
);

grant usage on type "public"."wf_app_role" to "postgres";
