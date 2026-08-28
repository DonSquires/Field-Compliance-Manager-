create table "public"."bob_context_memory" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "user_id"         uuid                     not null,
  "context_key"     text                     not null,
  "context_data"    jsonb                    not null default '{}'::jsonb,
  "last_seen_at"    timestamp with time zone not null default now(),
  "created_at"      timestamp with time zone not null default now(),
  constraint "bob_context_memory_pkey" primary key (id),
  constraint "bob_context_memory_user_id_context_key_key" unique (user_id, context_key),
  constraint "bob_context_memory_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "bob_context_memory_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."bob_context_memory"
  enable row level security;

create policy "bcm_insert" on "public"."bob_context_memory"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "bcm_select" on "public"."bob_context_memory"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bcm_update" on "public"."bob_context_memory"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."bob_context_memory"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_context_memory" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_context_memory" is 'Per-user context memory for Bob. Allows Bob to be aware of what the user was working on across sessions.';
