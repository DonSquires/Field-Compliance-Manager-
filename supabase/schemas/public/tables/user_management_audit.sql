create table "public"."user_management_audit" (
  "id"             uuid                     not null default gen_random_uuid(),
  "target_user_id" uuid                     not null,
  "action_type"    text                     not null,
  "performed_by"   uuid                     not null,
  "old_value"      jsonb,
  "new_value"      jsonb,
  "metadata"       jsonb,
  "created_at"     timestamp with time zone not null default now(),
  constraint "user_management_audit_performed_by_fkey" foreign key (performed_by) references auth.users(id) on delete cascade,
  constraint "user_management_audit_pkey" primary key (id),
  constraint "user_management_audit_target_user_id_fkey" foreign key (target_user_id) references auth.users(id) on delete cascade
);

alter table "public"."user_management_audit"
  enable row level security;

create index idx_user_management_audit_action_type on public.user_management_audit using btree (action_type);

create index idx_user_management_audit_created_at on public.user_management_audit using btree (created_at desc);

create index idx_user_management_audit_performed_by on public.user_management_audit using btree (performed_by);

create index idx_user_management_audit_target_user on public.user_management_audit using btree (target_user_id);

create policy "Admins can view audit records for their org" on "public"."user_management_audit"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.user_profiles up
  where ((up.id = auth.uid()) AND (up.role = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text])) AND (up.organization_id = ( select user_profiles.organization_id
           from public.user_profiles
          where (user_profiles.id = user_management_audit.target_user_id)))))));

create policy "Service role can insert audit records" on "public"."user_management_audit"
  for insert
  to PUBLIC
  with check (true);

create policy "bob_full_read" on "public"."user_management_audit"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."user_management_audit" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."user_management_audit"."action_type" is 'Type of action: user_invited, user_activated, role_changed, display_name_changed, user_deactivated, user_reactivated, invite_resent';

comment on column "public"."user_management_audit"."metadata" is 'Additional context such as deactivation reason';

comment on table "public"."user_management_audit" is 'Audit trail for user management actions (invites, deactivations, role changes)';
