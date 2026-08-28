create table "public"."invoices" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "organization_id"        uuid                     not null,
  "client_organization_id" uuid                     not null,
  "service_agreement_id"   uuid,
  "invoice_number"         text                     not null,
  "invoice_date"           date                     not null default CURRENT_DATE,
  "due_date"               date                     not null,
  "status"                 text                     not null default 'draft'::text,
  "subtotal"               numeric(12,2)            not null default 0,
  "gst_amount"             numeric(12,2)            not null default 0,
  "total_amount"           numeric(12,2)            not null default 0,
  "currency"               text                     not null default 'NZD'::text,
  "notes"                  text,
  "created_by"             uuid,
  "created_at"             timestamp with time zone not null default now(),
  "updated_at"             timestamp with time zone not null default now(),
  "site_id"                uuid,
  "service_period_start"   date,
  "service_period_end"     date,
  "sent_at"                timestamp with time zone,
  "paid_at"                timestamp with time zone,
  constraint "invoices_pkey" primary key (id),
  constraint "invoices_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete set null,
  constraint "invoices_status_check" check ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'paid'::text, 'overdue'::text, 'void'::text]))),
  constraint "invoices_client_organization_id_fkey" foreign key (client_organization_id) references public.organizations(id),
  constraint "invoices_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "invoices_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id),
  constraint "invoices_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."invoices"
  enable row level security;

create index idx_invoices_client_org on public.invoices using btree (client_organization_id)
  where (client_organization_id is not null);

create index idx_invoices_client on public.invoices using btree (client_organization_id);

create index idx_invoices_due_date on public.invoices using btree (due_date);

create index idx_invoices_org on public.invoices using btree (organization_id);

create index idx_invoices_site_id on public.invoices using btree (site_id)
  where (site_id is not null);

create index idx_invoices_status on public.invoices using btree (status);

create policy "bob_full_read" on "public"."invoices"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."invoices"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "invoices_insert" on "public"."invoices"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "invoices_select" on "public"."invoices"
  for select
  to PUBLIC
  using ((public.org_access_allowed(organization_id) or public.org_access_allowed(client_organization_id)));

create policy "invoices_update" on "public"."invoices"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

create policy "org_access_invoices" on "public"."invoices"
  for all
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."invoices" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."invoices" is 'Invoice header records for client billing. Linked to service agreements.';
