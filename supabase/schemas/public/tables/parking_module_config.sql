create table "public"."parking_module_config" (
  "id"                         uuid                     not null default gen_random_uuid(),
  "organization_id"            uuid                     not null,
  "default_time_limit_minutes" integer                  not null default 60,
  "grace_period_minutes"       integer                  not null default 5,
  "infringement_fee_dollars"   numeric(10,2)            not null default 65.00,
  "require_photo_evidence"     boolean                  not null default true,
  "auto_escalate_overstay"     boolean                  not null default true,
  "legislative_text"           text,
  "updated_at"                 timestamp with time zone not null default now(),
  constraint "parking_module_config_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "parking_module_config_organization_id_key" unique (organization_id),
  constraint "parking_module_config_pkey" primary key (id)
);

alter table "public"."parking_module_config"
  enable row level security;

create policy "bob_full_read" on "public"."parking_module_config"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "pmc_insert" on "public"."parking_module_config"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "pmc_select" on "public"."parking_module_config"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "pmc_update" on "public"."parking_module_config"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."parking_module_config" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."parking_module_config"."auto_escalate_overstay" is 'When true, overstay records are automatically escalated for infringement review. Default true.';

comment on column "public"."parking_module_config"."default_time_limit_minutes" is 'Default parking time limit in minutes used when no zone-specific limit is set. Configurable per org.';

comment on column "public"."parking_module_config"."grace_period_minutes" is 'Grace period in minutes after the time limit expires before an overstay is flagged. Default 5.';

comment on column "public"."parking_module_config"."infringement_fee_dollars" is 'Default infringement fee in dollars for parking overstay notices. Configurable per org/bylaw.';

comment on column "public"."parking_module_config"."legislative_text" is 'Legislative framework text surfaced in parking infringement notices. Override for council-specific references.';

comment on column "public"."parking_module_config"."require_photo_evidence" is 'When true, officers must attach at least one photo before saving a chalk record. Default true.';

comment on table "public"."parking_module_config" is 'Per-org parking enforcement module configuration: default time limits, grace period, infringement fee, evidence requirements, escalation policy, and legislative text. Issue #113.';
