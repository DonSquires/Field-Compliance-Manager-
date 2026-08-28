create table "public"."zone_compliance_matrix" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "organization_id"        uuid                     not null,
  "zone_id"                uuid                     not null,
  "version"                integer                  not null default 1,
  "is_current"             boolean                  not null default true,
  "max_consecutive_nights" integer,
  "max_nights_per_month"   integer,
  "max_nights_per_year"    integer,
  "allowed_vehicle_types"  text[]                   default ARRAY['self_contained'::text,
  'tent'::text,
  'campervan'::text],
  "scv_required"           boolean                  not null default false,
  "no_camping_start_time"  time without time zone,
  "no_camping_end_time"    time without time zone,
  "restricted_from_date"   date,
  "restricted_to_date"     date,
  "effective_from"         date                     not null default CURRENT_DATE,
  "effective_to"           date,
  "bylaw_clause"           text,
  "bylaw_source_url"       text,
  "notes"                  text,
  "created_at"             timestamp with time zone not null default now(),
  "created_by"             uuid,
  constraint "zone_compliance_matrix_created_by_fkey" foreign key (created_by) references public.user_profiles(id),
  constraint "zone_compliance_matrix_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "zone_compliance_matrix_pkey" primary key (id),
  constraint "zone_compliance_matrix_zone_id_fkey" foreign key (zone_id) references public.location_zones(id)
);

alter table "public"."zone_compliance_matrix"
  enable row level security;

create index idx_zone_compliance_matrix_zone on public.zone_compliance_matrix using btree (zone_id, is_current);

create policy "bob_full_read" on "public"."zone_compliance_matrix"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "zone_compliance_matrix_insert" on "public"."zone_compliance_matrix"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "zone_compliance_matrix_select" on "public"."zone_compliance_matrix"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "zone_compliance_matrix_update" on "public"."zone_compliance_matrix"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."zone_compliance_matrix" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."zone_compliance_matrix" is 'Versioned compliance rules per zone. Supports bylaw amendments without losing history.';
