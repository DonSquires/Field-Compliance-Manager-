create table "public"."invoice_line_items" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "invoice_id"         uuid                     not null,
  "line_number"        integer                  not null,
  "description"        text                     not null,
  "quantity"           numeric(10,2)            not null default 1,
  "unit_price"         numeric(10,2)            not null,
  "line_total"         numeric(12,2)            not null,
  "created_at"         timestamp with time zone not null default now(),
  "organization_id"    uuid,
  "source_dispatch_id" uuid,
  constraint "invoice_line_items_pkey" primary key (id),
  constraint "invoice_line_items_invoice_id_fkey" foreign key (invoice_id) references public.invoices(id) on delete cascade,
  constraint "invoice_line_items_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."invoice_line_items"
  enable row level security;

create index idx_ili_invoice_id on public.invoice_line_items using btree (invoice_id);

create index idx_invoice_line_items_invoice on public.invoice_line_items using btree (invoice_id);

create unique index idx_invoice_line_items_source_dispatch on public.invoice_line_items using btree (organization_id, source_dispatch_id)
  where (source_dispatch_id is not null);

create policy "bob_full_read" on "public"."invoice_line_items"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."invoice_line_items"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "ili_insert" on "public"."invoice_line_items"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_line_items.invoice_id) AND public.org_access_allowed(i.organization_id)))));

create policy "ili_select" on "public"."invoice_line_items"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.invoices i
  where ((i.id = invoice_line_items.invoice_id) AND public.org_access_allowed(i.organization_id)))));

create policy "ili_update" on "public"."invoice_line_items"
  for update
  to PUBLIC
  using ((exists ( select 1
   from public.invoices i
  where ((i.id = invoice_line_items.invoice_id) AND public.is_admin_for_org(i.organization_id)))))
  with check ((EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_line_items.invoice_id) AND public.is_admin_for_org(i.organization_id)))));

create policy "invoice_line_items_insert" on "public"."invoice_line_items"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_line_items.invoice_id) AND public.is_admin_for_org(i.organization_id)))));

create policy "invoice_line_items_select" on "public"."invoice_line_items"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.invoices i
  where ((i.id = invoice_line_items.invoice_id) AND (public.org_access_allowed(i.organization_id) or public.org_access_allowed(i.client_organization_id))))));

create policy "invoice_line_items_update" on "public"."invoice_line_items"
  for update
  to PUBLIC
  using ((exists ( select 1
   from public.invoices i
  where ((i.id = invoice_line_items.invoice_id) AND public.is_admin_for_org(i.organization_id)))))
  with check ((EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_line_items.invoice_id) AND public.is_admin_for_org(i.organization_id)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."invoice_line_items" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."invoice_line_items" is 'Line items for invoices. Linked to invoices table.';
