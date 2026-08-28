create table "public"."monthly_report_packs" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "service_agreement_id" uuid                     not null,
  "template_code"        text                     not null,
  "period_start"         date                     not null,
  "period_end"           date                     not null,
  "status"               text                     not null default 'draft'::text,
  "data"                 jsonb,
  "pdf_path"             text,
  "generated_at"         timestamp with time zone,
  "generated_by"         uuid,
  "sent_at"              timestamp with time zone,
  "sent_to"              text,
  "delivery_error"       text,
  "created_at"           timestamp with time zone not null default now(),
  "updated_at"           timestamp with time zone not null default now(),
  constraint "monthly_report_packs_pkey" primary key (id),
  constraint "monthly_report_packs_service_agreement_id_template_code_per_key" unique (service_agreement_id, template_code, period_start),
  constraint "monthly_report_packs_status_check" check ((status = ANY (ARRAY['draft'::text, 'generated'::text, 'sent'::text, 'failed'::text]))),
  constraint "monthly_report_packs_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "monthly_report_packs_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete cascade,
  constraint "monthly_report_packs_generated_by_fkey" foreign key (generated_by) references public.user_profiles(id)
);

alter table "public"."monthly_report_packs"
  enable row level security;

create index idx_mrp_agreement on public.monthly_report_packs using btree (service_agreement_id, period_start desc);

create index idx_mrp_org_status on public.monthly_report_packs using btree (organization_id, status, period_start desc);

create policy "bob_full_read" on "public"."monthly_report_packs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "monthly_report_packs_insert" on "public"."monthly_report_packs"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "monthly_report_packs_select" on "public"."monthly_report_packs"
  for select
  to PUBLIC
  using ((public.org_access_allowed(organization_id) or (exists ( select 1
   from public.service_agreements sa
  where
    ((sa.id = monthly_report_packs.service_agreement_id) AND (public.org_access_allowed(sa.provider_organization_id) or public.org_access_allowed(sa.client_organization_id)))))));

create policy "monthly_report_packs_update" on "public"."monthly_report_packs"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."monthly_report_packs" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."monthly_report_packs" is 'Generated monthly report packs per service agreement. One row per period+template, with a JSONB data snapshot, PDF path, and delivery log. Feeds the client portal (3.3).';
