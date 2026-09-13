create table public.location_module_assignments (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  module_key text not null,
  service_agreement_id uuid not null references public.service_agreements(id) on delete cascade,
  enabled boolean not null default true,
  effective_from date not null default current_date,
  effective_to date,
  rule_set_ref uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.user_profiles(id),
  constraint location_module_assignments_dates_check check (effective_to is null or effective_to >= effective_from),
  constraint location_module_assignments_unique unique (location_id, module_key, service_agreement_id)
);

create index idx_location_module_assignments_lookup on public.location_module_assignments (location_id, module_key, enabled, effective_from desc);
alter table public.location_module_assignments enable row level security;
create policy location_module_assignments_select on public.location_module_assignments for select to authenticated using (public.org_access_allowed((select l.organization_id from public.locations l where l.id = location_id)));
create policy location_module_assignments_insert on public.location_module_assignments for insert to authenticated with check (public.is_admin_for_org((select sa.provider_organization_id from public.service_agreements sa where sa.id = service_agreement_id)));
create policy location_module_assignments_update on public.location_module_assignments for update to authenticated using (public.is_admin_for_org((select sa.provider_organization_id from public.service_agreements sa where sa.id = service_agreement_id))) with check (public.is_admin_for_org((select sa.provider_organization_id from public.service_agreements sa where sa.id = service_agreement_id)));
grant select, insert, update on table public.location_module_assignments to authenticated;
grant all on table public.location_module_assignments to service_role;
