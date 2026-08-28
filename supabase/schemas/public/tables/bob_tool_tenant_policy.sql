create table "public"."bob_tool_tenant_policy" (
  "id"                         uuid                     not null default gen_random_uuid(),
  "organization_id"            uuid                     not null,
  "tool_key"                   text                     not null,
  "enabled"                    boolean                  not null default true,
  "requires_approval_override" boolean,
  "created_at"                 timestamp with time zone not null default now(),
  constraint "bob_tool_tenant_policy_organization_id_tool_key_key" unique (organization_id, tool_key),
  constraint "bob_tool_tenant_policy_pkey" primary key (id),
  constraint "bob_tool_tenant_policy_tool_key_fkey" foreign key (tool_key) references public.bob_tool_registry(tool_key) on delete cascade,
  constraint "bob_tool_tenant_policy_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."bob_tool_tenant_policy"
  enable row level security;

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_tool_tenant_policy" to "anon", "authenticated", "postgres", "service_role";
