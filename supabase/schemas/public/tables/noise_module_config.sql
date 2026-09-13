create table "public"."noise_module_config" (
  "id"                          uuid                     not null default gen_random_uuid(),
  "organization_id"             uuid                     not null,
  "volume_bands"                jsonb,
  "time_bands"                  jsonb,
  "tone_bands"                  jsonb,
  "excessive_threshold"         smallint                 not null default 5,
  "supplementary_factors"       text[]                   not null default '{}'::text[],
  "supplementary_factor_config" jsonb                    default '{}'::jsonb,
  "permanent_abatement_list"    jsonb                    default '[]'::jsonb,
  "legislative_text"            text                     default 'Resource Management Act 1991 s.326 (Abatement Notice) / s.327 (Seizure of Noise Source)'::text,
  "require_occupant_dob"        boolean                  not null default false,
  "require_large_event_flag"    boolean                  not null default false,
  "version"                       integer                  not null default 1,
  "is_current"                    boolean                  not null default true,
  "effective_from"                date                     not null default current_date,
  "effective_to"                  date,
  "source_document_url"           text,
  "created_by"                     uuid,
  "created_at"                  timestamp with time zone not null default now(),
  "updated_at"                  timestamp with time zone not null default now(),
  "skip_verbal_warning"         boolean                  not null default false,
  constraint "noise_module_config_dates_check" check (effective_to is null or effective_to >= effective_from),
  constraint "noise_module_config_created_by_fkey" foreign key (created_by) references public.user_profiles(id),
  constraint "noise_module_config_pkey" primary key (id),
  constraint "uq_noise_module_config_org" unique (organization_id),
  constraint "noise_module_config_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."noise_module_config"
  enable row level security;

create policy "bob_full_read" on "public"."noise_module_config"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "nmc_delete" on "public"."noise_module_config"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "nmc_insert" on "public"."noise_module_config"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "nmc_select" on "public"."noise_module_config"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "nmc_update" on "public"."noise_module_config"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."noise_module_config" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."noise_module_config"."excessive_threshold" is 'Organization triage threshold for the configurable volume/time/tone matrix. It is not a replacement for the RMA 1991 s.326 enforcement-officer opinion that noise is excessive.';

comment on column "public"."noise_module_config"."legislative_text" is 'Legislative framework text surfaced in incident reports. Default: RMA 1991 s.326/s.327. Council override allowed.';

comment on column "public"."noise_module_config"."permanent_abatement_list" is 'Admin-managed list of addresses with permanent abatement notices. Replaces the static PDF. Each entry: { address, site_id, notes, added_at, added_by }.';

comment on column "public"."noise_module_config"."skip_verbal_warning" is 'When true, the TDC matrix skips the verbal warning step and issues an END (Excessive Noise Direction) on the first excessive noise finding. Issue #105.';

comment on column "public"."noise_module_config"."supplementary_factors" is 'Array of well-known supplementary factor type keys enabled for this org (e.g. day_of_week, duration, location_type). Combines with the base TDC score, does not replace it.';

comment on table "public"."noise_module_config" is 'Per-org noise control module configuration: matrix band definitions, supplementary factors, excessive threshold, permanent abatement list, and legislative text override. Issue #94.';
