create type "public"."report_status" as enum (
  'draft',
  'submitted',
  'reviewed',
  'closed'
);

grant usage on type "public"."report_status" to "postgres";
