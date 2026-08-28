create table "public"."crm_activity_log" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "actor_id"        uuid,
  "activity_type"   text                     not null default 'note'::text,
  "subject"         text                     not null,
  "body"            text,
  "follow_up_at"    timestamp with time zone,
  "created_at"      timestamp with time zone not null default now(),
  constraint "crm_activity_log_activity_type_check"
    check ((activity_type = ANY (ARRAY['note'::text, 'meeting'::text, 'call'::text, 'email'::text, 'site_visit'::text, 'follow_up'::text]))),
  constraint "crm_activity_log_pkey" primary key (id),
  constraint "crm_activity_log_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "crm_activity_log_actor_id_fkey" foreign key (actor_id) references public.user_profiles(id)
);

alter table "public"."crm_activity_log"
  enable row level security;

create index idx_crm_activity_log_org_created on public.crm_activity_log using btree (organization_id, created_at desc);

create policy "bob_full_read" on "public"."crm_activity_log"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "crm_activity_log_delete" on "public"."crm_activity_log"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "crm_activity_log_insert" on "public"."crm_activity_log"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "crm_activity_log_select" on "public"."crm_activity_log"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "crm_activity_log_update" on "public"."crm_activity_log"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."crm_activity_log" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."crm_activity_log" is 'CRM activity timeline: meeting notes, calls, emails, site visits, and follow-ups for client/prospect accounts.';
