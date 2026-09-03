create table "public"."bob_conversations" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "user_id"         uuid                     not null,
  "module_key"      text,
  "title"           text,
  "pinned"          boolean                  not null default false,
  "archived_at"     timestamp with time zone,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "bob_conversations_pkey" primary key (id),
  constraint "bob_conversations_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "bob_conversations_user_id_fkey" foreign key (user_id) references public.user_profiles(id)
);

alter table "public"."bob_conversations"
  enable row level security;

create policy "bob_conversations_insert" on "public"."bob_conversations"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "bob_conversations_select" on "public"."bob_conversations"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bob_conversations_update" on "public"."bob_conversations"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."bob_conversations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_conversations" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."bob_conversations" is 'Bob AI conversation sessions per user per org. Scoped by module context.';
