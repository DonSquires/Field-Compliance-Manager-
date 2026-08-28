create table "public"."officer_welfare_settings" (
  "id"                              uuid                     not null default gen_random_uuid(),
  "organization_id"                 uuid                     not null,
  "officer_user_id"                 uuid                     not null,
  "welfare_check_enabled"           boolean                  not null default true,
  "auto_logoff_enabled"             boolean                  not null default false,
  "check_interval_minutes"          integer                  not null default 30,
  "last_checkin_at"                 timestamp with time zone,
  "inactivity_warning_time"         integer                  not null default 10,
  "auto_logoff_time"                integer                  not null default 20,
  "gps_inactivity_threshold"        integer                  not null default 10,
  "admin_escalation_time"           integer                  not null default 5,
  "critical_escalation_time"        integer                  not null default 5,
  "man_down_enabled"                boolean                  not null default true,
  "man_down_stationary_minutes"     integer                  not null default 15,
  "man_down_escalation_minutes"     integer                  not null default 5,
  "investigation_exception_enabled" boolean                  not null default true,
  "created_at"                      timestamp with time zone not null default now(),
  "updated_at"                      timestamp with time zone not null default now(),
  "identity_gate_enabled"           boolean                  not null default false,
  "identity_gate_config"            jsonb                    not null default '{}'::jsonb,
  constraint "officer_welfare_settings_officer_user_id_organization_id_key" unique (officer_user_id, organization_id),
  constraint "officer_welfare_settings_pkey" primary key (id),
  constraint "officer_welfare_settings_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "officer_welfare_settings_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."officer_welfare_settings"
  enable row level security;

create index idx_ows_officer on public.officer_welfare_settings using btree (officer_user_id);

create index idx_ows_org on public.officer_welfare_settings using btree (organization_id);

create trigger trg_ows_updated_at
  before update on public.officer_welfare_settings
  for each row
  execute function public.set_welfare_settings_updated_at();

create policy "bob_full_read" on "public"."officer_welfare_settings"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ows_select" on "public"."officer_welfare_settings"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ows_write" on "public"."officer_welfare_settings"
  for all
  to PUBLIC
  using (((officer_user_id = auth.uid()) or public.is_admin_for_org(organization_id)))
  with check (((officer_user_id = auth.uid()) OR public.is_admin_for_org(organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."officer_welfare_settings" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."officer_welfare_settings"."identity_gate_config" is 'Admin-configured welfare cancel/resolve identity gate. Shape (example): { "sos": ["face"], "man_down": ["face","device_biometric"] } = which alert types require verification and which methods are acceptable. Empty = no gate. face_match is the stronger anti-spoof control for high-risk alerts.';

comment on table "public"."officer_welfare_settings" is 'Per-officer welfare/lone-worker configuration (HSWA 2015): interval, escalation timings, man-down (GPS-stationary), auto-logoff.';
