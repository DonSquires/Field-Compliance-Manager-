create table "public"."bob_tool_registry" (
  "id"                uuid                     not null default gen_random_uuid(),
  "tool_key"          text                     not null,
  "display_name"      text                     not null,
  "description"       text                     not null,
  "endpoint_url"      text                     not null,
  "http_method"       text                     not null default 'POST'::text,
  "auth_mode"         text                     not null,
  "risk_level"        text                     not null,
  "requires_approval" boolean                  not null default false,
  "timeout_ms"        integer                  not null default 15000,
  "retry_limit"       integer                  not null default 1,
  "enabled"           boolean                  not null default true,
  "retired_at"        timestamp with time zone,
  "created_at"        timestamp with time zone not null default now(),
  "updated_at"        timestamp with time zone not null default now(),
  constraint "bob_tool_registry_auth_mode_check" check ((auth_mode = ANY (ARRAY['jwt'::text, 'service_role'::text, 'none'::text]))),
  constraint "bob_tool_registry_pkey" primary key (id),
  constraint "bob_tool_registry_risk_level_check" check ((risk_level = ANY (ARRAY['read'::text, 'write'::text, 'destructive'::text, 'deploy'::text, 'secret'::text]))),
  constraint "bob_tool_registry_tool_key_key" unique (tool_key)
);

alter table "public"."bob_tool_registry"
  enable row level security;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_tool_registry" to "anon", "authenticated", "postgres", "service_role";
