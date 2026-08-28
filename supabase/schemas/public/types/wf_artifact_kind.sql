create type "public"."wf_artifact_kind" as enum (
  'log',
  'report',
  'bundle'
);

grant usage on type "public"."wf_artifact_kind" to "postgres";
