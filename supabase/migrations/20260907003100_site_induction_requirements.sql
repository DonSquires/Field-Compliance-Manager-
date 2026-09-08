-- Site/zone induction is a place qualification, not a global staff skill.

create table if not exists public.site_induction_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_site_id uuid references public.client_sites(id) on delete cascade,
  zone_id uuid references public.location_zones(id) on delete cascade,
  service_agreement_location_id uuid references public.service_agreement_locations(id) on delete cascade,
  induction_name text not null,
  version text,
  required boolean not null default true,
  expires_after_days integer,
  active boolean not null default true,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(client_site_id, zone_id, service_agreement_location_id) >= 1)
);

create table if not exists public.staff_site_inductions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requirement_id uuid not null references public.site_induction_requirements(id) on delete cascade,
  staff_id uuid not null references public.staff_profiles(id) on delete cascade,
  completed_at timestamptz not null default now(),
  expires_at timestamptz,
  evidence_notes text,
  verified_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (requirement_id, staff_id)
);

alter table public.site_induction_requirements enable row level security;
alter table public.staff_site_inductions enable row level security;
create policy site_induction_requirements_select on public.site_induction_requirements for select using (public.org_access_allowed(organization_id));
create policy staff_site_inductions_select on public.staff_site_inductions for select using (public.org_access_allowed(organization_id));
revoke all on public.site_induction_requirements, public.staff_site_inductions from public, anon, authenticated;
grant select on public.site_induction_requirements, public.staff_site_inductions to authenticated;
grant all on public.site_induction_requirements, public.staff_site_inductions to service_role;

create or replace function public.get_site_induction_state(p_staff_id uuid, p_service_agreement_location_id uuid)
returns table (requirement_id uuid, induction_name text, required boolean, completed boolean, expires_at timestamptz)
language sql security definer stable set search_path = public as $$
  select r.id, r.induction_name, r.required,
    exists(select 1 from public.staff_site_inductions si where si.requirement_id = r.id and si.staff_id = p_staff_id and (si.expires_at is null or si.expires_at >= current_date)),
    (select si.expires_at from public.staff_site_inductions si where si.requirement_id = r.id and si.staff_id = p_staff_id order by si.completed_at desc limit 1)
  from public.site_induction_requirements r
  where r.service_agreement_location_id = p_service_agreement_location_id and r.active;
$$;

revoke all on function public.get_site_induction_state(uuid, uuid) from public, anon;
grant execute on function public.get_site_induction_state(uuid, uuid) to authenticated, service_role;
