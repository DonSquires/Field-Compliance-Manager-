create table "public"."organizations" (
  "id"                            uuid                               not null default gen_random_uuid(),
  "name"                          text                               not null,
  "organization_type"             text                               not null,
  "parent_organization_id"        uuid,
  "created_at"                    timestamp with time zone           not null default now(),
  "active"                        boolean                            not null default true,
  "contact_email"                 text,
  "contact_phone"                 text,
  "billing_email"                 text,
  "billing_address"               text,
  "account_notes"                 text,
  "enforcement_workflow_mode"     text                               not null default 'officer_direct'::text,
  "organization_level"            smallint,
  "status"                        text                               not null default 'active'::text,
  "logo_url"                      text,
  "jurisdiction_geom"             public.geometry(MultiPolygon,4326),
  "external_refs"                 jsonb                              not null default '{}'::jsonb,
  "company_registration_number"   text,
  "nzbn"                          text,
  "corporate_status"              text,
  "corporate_status_as_of"        timestamp with time zone,
  "corporate_profile_verified_by" uuid,
  "corporate_profile_verified_at" timestamp with time zone,
  "nzbn_entity_type"              text,
  "discoverable"                  boolean                            not null default false,
  "jurisdiction_verification"     text                               not null default 'unverified'::text,
  "jurisdiction_verified_by"      uuid,
  "jurisdiction_verified_at"      timestamp with time zone,
  constraint "organizations_corporate_status_check"
    check ((corporate_status = ANY (ARRAY['registered'::text, 'removed'::text, 'in_liquidation'::text, 'receivership'::text, 'unknown'::text]))),
  constraint "organizations_enforcement_workflow_mode_check" check ((enforcement_workflow_mode = ANY (ARRAY['admin_first'::text, 'officer_direct'::text, 'hybrid'::text]))),
  constraint "organizations_jurisdiction_verification_check" check ((jurisdiction_verification = ANY (ARRAY['unverified'::text, 'verified'::text]))),
  constraint "organizations_nzbn_entity_type_check"
    check ((nzbn_entity_type = ANY (ARRAY['company'::text, 'sole_trader'::text, 'partnership'::text, 'trust'::text, 'other'::text]))),
  constraint "organizations_organization_type_check"
    check
    ((organization_type = ANY (ARRAY['owner'::text, 'service_provider'::text, 'branch'::text, 'client'::text, 'contractor'::text, 'government'::text,
    'private_enterprise'::text]))),
  constraint "organizations_pkey" primary key (id),
  constraint "organizations_parent_organization_id_fkey" foreign key (parent_organization_id) references public.organizations(id),
  constraint "organizations_status_check" check ((status = ANY (ARRAY['prospect'::text, 'active'::text, 'suspended'::text, 'archived'::text])))
);

alter table "public"."organizations"
  enable row level security;

create index idx_organizations_external_refs on public.organizations using gin (external_refs);

create index idx_organizations_jurisdiction_geom on public.organizations using gist (jurisdiction_geom);

create unique index idx_organizations_nzbn_unique on public.organizations using btree (nzbn)
  where (nzbn is not null);

create index idx_organizations_parent on public.organizations using btree (parent_organization_id);

create index idx_organizations_type_level on public.organizations using btree (organization_type, organization_level);

create trigger trg_org_set_level
  before insert or update of parent_organization_id, organization_type on public.organizations
  for each row
  execute function public.org_set_level();

create policy "bob_full_read" on "public"."organizations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."organizations"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "master_manage_orgs_insert" on "public"."organizations"
  for insert
  to "authenticated"
  with check (((organization_type = ANY (ARRAY['client'::text, 'branch'::text, 'contractor'::text])) AND (parent_organization_id IS
    NOT NULL) AND public.is_master_for_org(parent_organization_id)));

create policy "master_manage_orgs_update" on "public"."organizations"
  for update
  to "authenticated"
  using (public.is_master_for_org(id))
  with check (public.is_master_for_org(id));

create policy "organizations_insert" on "public"."organizations"
  for insert
  to PUBLIC
  with check (public.is_grand_master());

create policy "organizations_select_parent_master" on "public"."organizations"
  for select
  to "authenticated"
  using (((parent_organization_id is not null) AND public.is_master_for_org(parent_organization_id)));

create policy "organizations_select" on "public"."organizations"
  for select
  to PUBLIC
  using (public.org_access_allowed(id));

create policy "organizations_update" on "public"."organizations"
  for update
  to PUBLIC
  using (public.is_grand_master())
  with check (public.is_grand_master());

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."organizations" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."organizations"."account_notes" is 'General CRM account notes visible to admins and masters.';

comment on column "public"."organizations"."active" is 'CRM account status. Inactive accounts remain visible for audit/history but are excluded from active operations.';

comment on column "public"."organizations"."billing_address" is 'Billing address for finance/invoicing workflows.';

comment on column "public"."organizations"."billing_email" is 'Billing contact email for finance/invoicing workflows.';

comment on column "public"."organizations"."company_registration_number" is 'NZ Companies Office registration number. Distinct from nzbn (New Zealand Business Number), which some entities have without being a registered company.';

comment on column "public"."organizations"."contact_email" is 'Primary organisation-level contact email used by CRM and onboarding workflows.';

comment on column "public"."organizations"."contact_phone" is 'Primary organisation-level contact phone used by CRM and operational handoff.';

comment on column "public"."organizations"."corporate_profile_verified_at" is 'When a human approved the corporate profile. NULL = unverified (registry-resolved only, not human-confirmed).';

comment on column "public"."organizations"."corporate_profile_verified_by" is 'Human who approved the corporate profile (registration number + officers) as correct. NULL means Bob resolved it but no human has confirmed it yet.';

comment on column "public"."organizations"."corporate_status" is 'Registry-reported standing at corporate_status_as_of. registered = active/trade-legal; removed/in_liquidation/receivership must be surfaced to the approver, never silently treated as active.';

comment on column "public"."organizations"."corporate_status_as_of" is 'Timestamp the corporate_status was last confirmed against the registry. Registry data can be up to a month stale — never presented as real-time.';

comment on column "public"."organizations"."discoverable" is 'Opt-in to org-to-org discovery (design doc 6.4). When false (default), the org is only findable by strong identifier (NZBN / exact name) and personal data is masked for non-company entity types. Iron Eagle (grand_master) sees all orgs regardless.';

comment on column "public"."organizations"."enforcement_workflow_mode" is 'Org default enforcement workflow: admin_first | officer_direct | hybrid. Zones may override via location_zones.enforcement_workflow_override.';

comment on column "public"."organizations"."external_refs" is 'Generic external system reference IDs. Keys are system names (wilsar, deputy, greentree, d365, etc.), values are objects of field->value pairs.';

comment on column "public"."organizations"."jurisdiction_geom" is 'Org operating boundary (service provider = all operated districts as one MultiPolygon; council = its district). Null for private enterprise. Layer 1/2 of geofence resolution.';

comment on column "public"."organizations"."nzbn" is 'New Zealand Business Number — the stable structural anchor for corporate entity resolution (names are mutable; the NZBN is not).';

comment on column "public"."organizations"."nzbn_entity_type" is 'NZBN entity type: company | sole_trader | partnership | trust | other. Drives privacy masking -- non-company types have personal data masked by default in org discovery (Privacy Act, design doc 6.2). Populated from the NZBN API lookup (W3) or manual entry.';

comment on index "public"."idx_organizations_nzbn_unique" is 'Partial unique index: at most one org per NZBN. NULLs excluded (NZBN is optional). Prevents duplicate org creation when NZBN is known (design doc 6.1, 6.3).';

comment on policy "organizations_select_parent_master" on "public"."organizations" is 'Additive permissive SELECT (0311): a row is visible if the caller is master/admin of its parent (is_master_for_org(parent_organization_id)). OR-combines with the existing organizations SELECT policy - strict widening, never narrowing. Fixes the branch-create RETURNING readback 42501 without depending on the existing policy definition.';

comment on table "public"."organizations" is 'Tenancy anchor. Supports platform owners, service providers, branches, clients, contractors, government entities, and private enterprises.';
