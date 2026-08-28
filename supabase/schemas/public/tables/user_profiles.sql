create table "public"."user_profiles" (
  "id"                          uuid                     not null,
  "organization_id"             uuid                     not null,
  "role"                        text                     not null,
  "display_name"                text,
  "authorized_organization_ids" uuid[]                   not null default '{}'::uuid[],
  "created_at"                  timestamp with time zone not null default now(),
  "deactivated_at"              timestamp with time zone,
  "deactivated_by"              uuid,
  "email"                       text,
  "phone"                       text,
  "address"                     text,
  "photo_url"                   text,
  "module_access"               text[]                   not null default '{}'::text[],
  "employer_organization_id"    uuid,
  constraint "user_profiles_deactivated_by_fkey" foreign key (deactivated_by) references auth.users(id),
  constraint "user_profiles_pkey" primary key (id),
  constraint "user_profiles_role_check"
    check
    ((role = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text, 'nzscv_monitor'::text, 'officer'::text, 'client_admin'::text,
    'client_officer'::text, 'client_viewer'::text])))
);

alter table "public"."user_profiles"
  enable row level security;

create index idx_user_profiles_deactivated_at on public.user_profiles using btree (deactivated_at)
  where (deactivated_at is not null);

create index idx_user_profiles_email on public.user_profiles using btree (email);

create index idx_user_profiles_employer on public.user_profiles using btree (employer_organization_id);

create index idx_user_profiles_module_access on public.user_profiles using gin (module_access);

create trigger trg_create_welfare_settings
  after insert on public.user_profiles
  for each row
  execute function public.create_default_welfare_settings();

create policy "bob_full_read" on "public"."user_profiles"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."user_profiles"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "user_profiles_insert" on "public"."user_profiles"
  for insert
  to PUBLIC
  with
    check ((public.is_grand_master() OR ((public.current_user_role() = ANY (ARRAY['master'::text, 'admin'::text])) AND (organization_id = ( SELECT user_profiles_1.organization_id
   FROM public.user_profiles user_profiles_1
  WHERE (user_profiles_1.id = auth.uid())
 LIMIT 1)))));

create policy "user_profiles_select" on "public"."user_profiles"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "user_profiles_update" on "public"."user_profiles"
  for update
  to PUBLIC
  using (((id = auth.uid()) or public.is_admin_for_org(organization_id)))
  with check (((id = auth.uid()) OR public.is_admin_for_org(organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."user_profiles" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."user_profiles"."address" is 'Physical/residential address. Used for payroll, emergency contact, and compliance records.';

comment on column "public"."user_profiles"."email" is 'Invite/contact email. Stored at invite time so the UI can show Resend without service-role access.';

comment on column "public"."user_profiles"."module_access" is 'Modules the officer can access directly without a roster shift.
   Set by admin. Empty array = roster-gated (default).
   Values: freedom_camping, parking, noise_control, biosecurity,
   smoke_control, site_guard, ems, patrol';

comment on column "public"."user_profiles"."phone" is 'Primary contact phone number (mobile preferred).';

comment on column "public"."user_profiles"."photo_url" is 'Supabase Storage path to head-and-shoulders profile photo. Validated by Bob AI before saving. Used for ID cards, face recognition, and access control.';

comment on column "public"."user_profiles"."role" is 'User rank (naval-tier model): grand_master (admiral) / master (captain) / admin (commander) / admin_officer (officer) / officer (ensign) / guest. Bob''s system user (00000000-0000-0000-0000-00000000b0b0) is grand_master within Iron Eagle (owner org) as of 0185. Note: there is no code-level guard preventing a human from approving a Bob-originated action -- bob-proposal-approver permits this by design. Attribution of approved_by to a real human is a design discipline, not an enforced invariant.';

comment on table "public"."user_profiles" is 'Application profile mapped to auth.users. RLS helper functions read this table.';
