create type "public"."report_type" as enum (
  'incident',
  'maintenance',
  'health_safety'
);

grant usage on type "public"."report_type" to "postgres";
