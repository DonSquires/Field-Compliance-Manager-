create type "public"."report_severity" as enum (
  'low',
  'medium',
  'high',
  'critical'
);

grant usage on type "public"."report_severity" to "postgres";
