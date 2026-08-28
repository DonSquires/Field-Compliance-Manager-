create type "public"."access_basis_verdict" as (
  "id"                   uuid,
  "decision_state"       text,
  "granted_basis"        text,
  "failed_gate"          text,
  "expiry_end_condition" text,
  "sensitivity_mode"     text,
  "message_key"          text
);

grant usage on type "public"."access_basis_verdict" to "postgres";
