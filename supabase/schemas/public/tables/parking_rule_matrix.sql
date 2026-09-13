create table "public"."parking_rule_matrix" (
  "id" uuid not null default gen_random_uuid(),
  "organization_id" uuid not null,
  "zone_id" uuid,
  "version" integer not null default 1,
  "is_current" boolean not null default true,
  "effective_from" date not null default current_date,
  "effective_to" date,
  "time_limit_minutes" integer not null,
  "grace_period_minutes" integer not null default 5,
  "disabled_multiplier" numeric(6,2) not null default 1,
  "infringement_fee" numeric(10,2),
  "legislative_text" text,
  "require_photo_evidence" boolean not null default true,
  "auto_escalate_overstay" boolean not null default true,
  "notes" text,
  "created_at" timestamptz not null default now(),
  "created_by" uuid,
  constraint "parking_rule_matrix_pkey" primary key (id),
  constraint "parking_rule_matrix_scope_version_key" unique (organization_id, zone_id, version),
  constraint "parking_rule_matrix_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "parking_rule_matrix_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade,
  constraint "parking_rule_matrix_created_by_fkey" foreign key (created_by) references public.user_profiles(id),
  constraint "parking_rule_matrix_time_limit_check" check (time_limit_minutes > 0),
  constraint "parking_rule_matrix_grace_check" check (grace_period_minutes >= 0),
  constraint "parking_rule_matrix_multiplier_check" check (disabled_multiplier >= 1),
  constraint "parking_rule_matrix_dates_check" check (effective_to is null or effective_to >= effective_from)
);

alter table public.parking_rule_matrix enable row level security;
create policy "parking_rule_matrix_select" on public.parking_rule_matrix for select to authenticated using (public.org_access_allowed(organization_id));
create policy "parking_rule_matrix_insert" on public.parking_rule_matrix for insert to authenticated with check (public.is_admin_for_org(organization_id));
create policy "parking_rule_matrix_update" on public.parking_rule_matrix for update to authenticated using (public.is_admin_for_org(organization_id)) with check (public.is_admin_for_org(organization_id));
grant select, insert, update on table public.parking_rule_matrix to authenticated;
grant all on table public.parking_rule_matrix to service_role;
