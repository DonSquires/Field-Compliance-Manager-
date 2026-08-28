create table "public"."freedom_camping_org_settings" (
  "id"                            uuid                     not null default gen_random_uuid(),
  "organization_id"               uuid                     not null,
  "version"                       integer                  not null default 1,
  "is_current"                    boolean                  not null default true,
  "verification_mode"             text                     not null default 'two_photo_verified'::text,
  "enforcement_ladder_mode"       text                     not null default 'warn_first'::text,
  "movement_similarity_threshold" double precision,
  "default_authorising_act"       text,
  "default_issuing_authority"     text,
  "show_homeless_exempt_kpi"      boolean                  not null default true,
  "effective_from"                date                     not null default CURRENT_DATE,
  "notes"                         text,
  "created_at"                    timestamp with time zone not null default now(),
  "created_by"                    uuid,
  constraint "freedom_camping_org_settings_enforcement_ladder_mode_check" check ((enforcement_ladder_mode = ANY (ARRAY['warn_first'::text, 'strict'::text]))),
  constraint "freedom_camping_org_settings_organization_id_version_key" unique (organization_id, version),
  constraint "freedom_camping_org_settings_pkey" primary key (id),
  constraint "freedom_camping_org_settings_verification_mode_check" check ((verification_mode = ANY (ARRAY['two_photo_verified'::text, 'single_daily_observation'::text]))),
  constraint "freedom_camping_org_settings_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "freedom_camping_org_settings_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."freedom_camping_org_settings"
  enable row level security;

create index idx_fc_org_settings_org_current on public.freedom_camping_org_settings using btree (organization_id, is_current);

create policy "bob_full_read" on "public"."freedom_camping_org_settings"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "freedom_camping_org_settings_insert" on "public"."freedom_camping_org_settings"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "freedom_camping_org_settings_select" on "public"."freedom_camping_org_settings"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "freedom_camping_org_settings_update" on "public"."freedom_camping_org_settings"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."freedom_camping_org_settings"
  to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."freedom_camping_org_settings" is 'Per-council Freedom Camping policy configuration (verification mode, enforcement-ladder mode, movement threshold, legal defaults). Lets every council use the same compliance engine with their own operational + bylaw choices. Versioned; is_current=true row is authoritative. #72/#74.';
