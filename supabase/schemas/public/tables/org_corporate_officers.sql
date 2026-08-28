create table "public"."org_corporate_officers" (
  "id"                          uuid                     not null default gen_random_uuid(),
  "organization_id"             uuid                     not null,
  "officer_role"                text                     not null,
  "full_name"                   text                     not null,
  "address_for_service"         text,
  "contact_email"               text,
  "contact_phone"               text,
  "shareholding_percentage"     numeric(5,2),
  "source"                      text                     not null default 'companies_office'::text,
  "source_as_of"                timestamp with time zone,
  "registry_verified"           boolean                  not null default false,
  "notes"                       text,
  "created_at"                  timestamp with time zone not null default now(),
  "updated_at"                  timestamp with time zone not null default now(),
  "adverse_notice_status"       text,
  "adverse_notice_reference"    text,
  "adverse_notice_source_url"   text,
  "adverse_notice_published_at" timestamp with time zone,
  "adverse_notice_effective_at" timestamp with time zone,
  "adverse_notice_search_as_of" timestamp with time zone,
  constraint "org_corporate_officers_adverse_notice_status_check"
    check ((adverse_notice_status = ANY (ARRAY['none_found'::text, 'bankruptcy'::text, 'liquidation_associated'::text, 'receivership_associated'::text, 'other_notice'::text]))),
  constraint "org_corporate_officers_officer_role_check" check ((officer_role = ANY (ARRAY['director'::text, 'shareholder'::text, 'director_and_shareholder'::text]))),
  constraint "org_corporate_officers_pkey" primary key (id),
  constraint "org_corporate_officers_source_check" check ((source = ANY (ARRAY['companies_office'::text, 'nzbn_register'::text, 'manual_entry'::text, 'other'::text]))),
  constraint "org_corporate_officers_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."org_corporate_officers"
  enable row level security;

create index idx_org_corporate_officers_org on public.org_corporate_officers using btree (organization_id);

create policy "bob_full_read" on "public"."org_corporate_officers"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "org_corporate_officers_select" on "public"."org_corporate_officers"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "org_corporate_officers_write" on "public"."org_corporate_officers"
  for all
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."org_corporate_officers" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."org_corporate_officers"."address_for_service" is 'Legal address for service (as filed with the registry). NEVER a personal residential address — do not populate from any source that only offers a home address.';

comment on column "public"."org_corporate_officers"."adverse_notice_effective_at" is 'The legally effective date stated WITHIN the notice text (e.g. date of adjudication/appointment), which can differ from the publication date by the ~2-working-day Gazette lag or more.';

comment on column "public"."org_corporate_officers"."adverse_notice_published_at" is 'When the notice was PUBLISHED in the Gazette. May differ from the legally effective date — see adverse_notice_effective_at.';

comment on column "public"."org_corporate_officers"."adverse_notice_reference" is 'Gazette notice reference/id, if a matching notice was found.';

comment on column "public"."org_corporate_officers"."adverse_notice_search_as_of" is 'Timestamp the Gazette search was performed. The digital record is only continuously searchable from 2000 onwards — a search with no hits confirms only "no hit in that window", never "no historic notice exists".';

comment on column "public"."org_corporate_officers"."adverse_notice_source_url" is 'Link to the Gazette notice text, if found.';

comment on column "public"."org_corporate_officers"."adverse_notice_status" is '''none_found'' means no digital Gazette hit within the searchable window (post-2000) — NOT a guarantee of a clean historic record. Never presented as "clear"; always paired with adverse_notice_search_as_of.';

comment on table "public"."org_corporate_officers" is 'Directors and majority shareholders for an organization''s corporate profile. address_for_service is a legal service address, never a personal address. registry_verified means a registry lookup returned this row; it does NOT mean a human has confirmed it — see organizations.corporate_profile_verified_by/at.';
