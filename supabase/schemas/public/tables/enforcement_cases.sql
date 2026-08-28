create table "public"."enforcement_cases" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "plate_number"     text                     not null,
  "zone_id"          uuid,
  "case_reference"   text,
  "case_type"        text                     not null default 'repeat_breach'::text,
  "status"           text                     not null default 'open'::text,
  "priority"         text                     not null default 'medium'::text,
  "assigned_to"      uuid,
  "summary"          text,
  "resolution_notes" text,
  "resolved_at"      timestamp with time zone,
  "created_at"       timestamp with time zone not null default now(),
  "updated_at"       timestamp with time zone not null default now(),
  constraint "enforcement_cases_case_type_check"
    check ((case_type = ANY (ARRAY['repeat_breach'::text, 'trespass'::text, 'infringement_non_payment'::text, 'court_referral'::text, 'welfare'::text, 'other'::text]))),
  constraint "enforcement_cases_pkey" primary key (id),
  constraint "enforcement_cases_priority_check" check ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
  constraint "enforcement_cases_status_check" check ((status = ANY (ARRAY['open'::text, 'active'::text, 'resolved'::text, 'court'::text, 'closed'::text]))),
  constraint "enforcement_cases_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "enforcement_cases_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "enforcement_cases_assigned_to_fkey" foreign key (assigned_to) references public.user_profiles(id)
);

alter table "public"."enforcement_cases"
  enable row level security;

create index idx_enforcement_cases_org_status on public.enforcement_cases using btree (organization_id, status, created_at desc);

create index idx_enforcement_cases_plate on public.enforcement_cases using btree (plate_number, created_at desc);

create policy "bob_full_read" on "public"."enforcement_cases"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "enforcement_cases_insert" on "public"."enforcement_cases"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "enforcement_cases_select" on "public"."enforcement_cases"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "enforcement_cases_update" on "public"."enforcement_cases"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."enforcement_cases" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."enforcement_cases" is 'Case management for repeat offenders. Full audit trail from first contact to court.';
