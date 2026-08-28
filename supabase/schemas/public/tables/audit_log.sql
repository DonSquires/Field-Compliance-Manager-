create table "public"."audit_log" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid,
  "actor_user_id"   uuid,
  "action"          text                     not null,
  "target_table"    text,
  "target_id"       uuid,
  "metadata"        jsonb                    not null default '{}'::jsonb,
  "created_at"      timestamp with time zone not null default now(),
  constraint "audit_log_pkey" primary key (id),
  constraint "audit_log_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "audit_log_actor_user_id_fkey" foreign key (actor_user_id) references public.user_profiles(id)
);

alter table "public"."audit_log"
  enable row level security;

create policy "audit_log_insert" on "public"."audit_log"
  for insert
  to PUBLIC
  with check (((organization_id IS NULL) OR public.org_access_allowed(organization_id)));

create policy "audit_log_select" on "public"."audit_log"
  for select
  to PUBLIC
  using (((organization_id is null) or public.org_access_allowed(organization_id)));

create policy "bob_full_read" on "public"."audit_log"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."audit_log" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."audit_log" is 'Append-only audit log. Records all significant platform actions with actor and timestamp.';
