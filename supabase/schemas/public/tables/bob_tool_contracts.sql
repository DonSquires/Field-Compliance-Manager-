create table "public"."bob_tool_contracts" (
  "id"            uuid                     not null default gen_random_uuid(),
  "tool_key"      text                     not null,
  "input_schema"  jsonb                    not null,
  "output_schema" jsonb                    not null,
  "version"       integer                  not null default 1,
  "is_current"    boolean                  not null default true,
  "created_at"    timestamp with time zone not null default now(),
  constraint "bob_tool_contracts_pkey" primary key (id),
  constraint "bob_tool_contracts_tool_key_fkey" foreign key (tool_key) references public.bob_tool_registry(tool_key) on delete cascade
);

alter table "public"."bob_tool_contracts"
  enable row level security;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_tool_contracts" to "anon", "authenticated", "postgres", "service_role";
