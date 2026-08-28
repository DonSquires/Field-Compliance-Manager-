create table "public"."notice_templates" (
  "id"                       uuid                     not null default gen_random_uuid(),
  "organization_id"          uuid                     not null,
  "notice_type"              text                     not null,
  "version"                  integer                  not null default 1,
  "is_active"                boolean                  not null default true,
  "issuing_authority"        text,
  "authorising_act"          text                     not null default 'Freedom Camping Act 2011'::text,
  "authorising_section"      text,
  "bylaw_reference"          text,
  "body_html"                text                     not null default ''::text,
  "fine_amount"              numeric(10,2),
  "payment_url"              text,
  "payment_deadline_days"    integer                  not null default 28,
  "objections_email"         text,
  "objections_address"       text,
  "objections_deadline_days" integer                  not null default 28,
  "vacate_by_hour"           integer                  not null default 7,
  "vacate_by_minute"         integer                  not null default 0,
  "logo_url"                 text,
  "footer_text"              text,
  "source_document_url"      text,
  "bob_extracted"            boolean                  not null default false,
  "created_at"               timestamp with time zone not null default now(),
  "created_by"               uuid,
  "updated_at"               timestamp with time zone not null default now(),
  constraint "notice_templates_notice_type_check"
    check ((notice_type = ANY (ARRAY['written_warning'::text, 'notice_to_vacate'::text, 'infringement'::text, 'end'::text, 'seizure'::text]))),
  constraint "notice_templates_organization_id_notice_type_version_key" unique (organization_id, notice_type, version),
  constraint "notice_templates_pkey" primary key (id),
  constraint "notice_templates_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "notice_templates_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."notice_templates"
  enable row level security;

create index idx_notice_templates_org_type_active on public.notice_templates using btree (organization_id, notice_type, is_active);

create policy "bob_full_read" on "public"."notice_templates"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "notice_templates_insert" on "public"."notice_templates"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "notice_templates_select" on "public"."notice_templates"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "notice_templates_update" on "public"."notice_templates"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."notice_templates" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."notice_templates"."notice_type" is 'Notice type: written_warning, notice_to_vacate, infringement (FC), end (Excessive Noise Direction), seizure (equipment seizure). Extended in 0218 for noise control (#60).';

comment on table "public"."notice_templates" is 'Per-council, per-notice-type reusable notice templates. Councils upload a sample; Bob extracts and proposes; admins edit manually. Versioned; is_active=true row is authoritative. Variables use {{placeholder}} syntax. #77.';
