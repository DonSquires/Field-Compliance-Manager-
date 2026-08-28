create type "public"."wf_actor_type" as enum (
  'user',
  'runner',
  'system'
);

grant usage on type "public"."wf_actor_type" to "postgres";
